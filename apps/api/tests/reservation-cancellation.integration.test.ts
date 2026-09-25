import { Client } from 'pg'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { buildApp } from '../src/app.js'
import {
  PaymentStatus,
  ReservationStatus,
  Role,
  SessionStatus,
  TicketStatus,
} from '../src/generated/prisma/enums.js'
import { prisma } from '../src/lib/prisma.js'

const TEST_SESSION_ADDRESS = 'Rua do Cancelamento, 701 — teste P0.1'
const SESSION_PRICE_CENTS = 4_200
const CANCELLATION_FAILURE_TRIGGER = 'P01_fail_reservation_seat_release'
const CANCELLATION_FAILURE_FUNCTION =
  'P01_fail_reservation_seat_release_function'
const CANCELLATION_FAILURE_TABLE = 'P01CancellationFailure'
const CANCELLATION_FAILURE_SEQUENCE = 'P01CancellationFailureHit'

interface TestSession {
  id: string
  seats: Array<{ id: string; label: string }>
}

interface HoldResponse {
  id: string
  status: ReservationStatus
}

interface PaymentResponse {
  payment: {
    id: string
    status: PaymentStatus
    amountCents: number
    createdAt: string
  }
  reservation: {
    id: string
    status: ReservationStatus
  }
  tickets: Array<{ id: string }>
}

interface TicketResponse {
  id: string
  status: TicketStatus
  manualCode: string | null
  qrToken: string | null
  reservation: {
    id: string
    status: ReservationStatus
    ticketCount: number
    canCancel: boolean
  }
}

type TicketSummaryResponse = Omit<TicketResponse, 'qrToken'>

interface CancellationResponse {
  reservation: {
    id: string
    status: ReservationStatus
  }
  tickets: Array<{
    id: string
    status: TicketStatus
  }>
}

interface SeatMapResponse {
  sessionId: string
  seats: Array<{
    id: string
    label: string
    status: 'AVAILABLE' | 'HELD' | 'SOLD'
  }>
}

interface SharedTicketResponse {
  id: string
  status: TicketStatus
  manualCode: string | null
  qrToken: string | null
}

interface GateResponse {
  result: 'VALID' | 'ALREADY_USED' | 'WRONG_EVENT' | 'INVALID'
}

type CustomerIdentity = 'CUSTOMER' | 'SECOND_CUSTOMER'
type AuthIdentity = Role | 'SECOND_CUSTOMER'

const app = buildApp()
const accessTokens = new Map<AuthIdentity, string>()
const createdSessionIds = new Set<string>()
let databaseSafetyConfirmed = false
let organizerId: string | null = null
let customerOneId: string | null = null
let customerTwoId: string | null = null

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error(
      'Os testes de cancelamento exigem NODE_ENV=test e DATABASE_URL local.',
    )
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Os testes de cancelamento recusaram um PostgreSQL não local.')
  }

  databaseSafetyConfirmed = true
}

function requiredIds() {
  if (!organizerId || !customerOneId || !customerTwoId) {
    throw new Error('Os usuários dos testes de cancelamento não foram inicializados.')
  }

  return { organizerId, customerOneId, customerTwoId }
}

function tokenFor(identity: AuthIdentity) {
  const accessToken = accessTokens.get(identity)

  if (!accessToken) {
    throw new Error(`Token de teste ausente para ${identity}.`)
  }

  return accessToken
}

function authorization(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` }
}

function futureDate(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1_000)
}

async function createTestSession(seatCount = 4): Promise<TestSession> {
  const session = await prisma.session.create({
    data: {
      organizerId: requiredIds().organizerId,
      status: SessionStatus.PUBLISHED,
      startsAt: futureDate(),
      venueName: 'Cine Cancelamento',
      roomName: 'Sala Histórico',
      address: TEST_SESSION_ADDRESS,
      priceCents: SESSION_PRICE_CENTS,
      tmdbMovieId: 701,
      movieTitle: 'O Assento Retorna',
      movieOverview: 'Sessão criada exclusivamente pela suíte P0.1.',
      moviePosterPath: '/p01-poster.jpg',
      movieBackdropPath: null,
      movieReleaseDate: new Date('2026-01-01T00:00:00.000Z'),
      movieRuntimeMinutes: 105,
      publishedAt: new Date(),
      seats: {
        create: Array.from({ length: seatCount }, (_, index) => ({
          rowLabel: 'A',
          number: index + 1,
          label: `A${index + 1}`,
        })),
      },
    },
    include: {
      seats: {
        select: { id: true, label: true },
        orderBy: { number: 'asc' },
      },
    },
  })

  createdSessionIds.add(session.id)

  return session
}

function createHoldRequest(
  sessionId: string,
  seatIds: string[],
  identity: CustomerIdentity = Role.CUSTOMER,
) {
  return app.inject({
    method: 'POST',
    url: '/reservations',
    headers: authorization(tokenFor(identity)),
    payload: { sessionId, seatIds },
  })
}

async function createSuccessfulHold(
  sessionId: string,
  seatIds: string[],
  identity: CustomerIdentity = Role.CUSTOMER,
) {
  const response = await createHoldRequest(sessionId, seatIds, identity)

  expect(response.statusCode).toBe(201)

  return response.json<HoldResponse>()
}

function payReservation(
  reservationId: string,
  identity: CustomerIdentity = Role.CUSTOMER,
) {
  return app.inject({
    method: 'POST',
    url: `/reservations/${reservationId}/payment`,
    headers: authorization(tokenFor(identity)),
    payload: { outcome: PaymentStatus.APPROVED },
  })
}

function cancelReservation(
  reservationId: string,
  identity: AuthIdentity = Role.CUSTOMER,
) {
  return app.inject({
    method: 'POST',
    url: `/reservations/${reservationId}/cancel`,
    headers: authorization(tokenFor(identity)),
  })
}

function getTicket(ticketId: string, identity: CustomerIdentity) {
  return app.inject({
    method: 'GET',
    url: `/me/tickets/${ticketId}`,
    headers: authorization(tokenFor(identity)),
  })
}

function createShareLink(ticketId: string, identity: CustomerIdentity) {
  return app.inject({
    method: 'POST',
    url: `/me/tickets/${ticketId}/share-link`,
    headers: authorization(tokenFor(identity)),
  })
}

function consumeTicket(sessionId: string, credential: string) {
  return app.inject({
    method: 'POST',
    url: '/gate/tickets/consume',
    headers: authorization(tokenFor(Role.GATE)),
    payload: { sessionId, credential },
  })
}

async function createPaidPurchase(
  session: TestSession,
  seatIndexes: number[],
  identity: CustomerIdentity = Role.CUSTOMER,
) {
  const seatIds = seatIndexes.map((index) => session.seats[index]!.id)
  const hold = await createSuccessfulHold(session.id, seatIds, identity)
  const paymentResponse = await payReservation(hold.id, identity)

  expect(paymentResponse.statusCode).toBe(200)

  const payment = paymentResponse.json<PaymentResponse>()
  expect(payment).toMatchObject({
    payment: {
      status: PaymentStatus.APPROVED,
      amountCents: SESSION_PRICE_CENTS * seatIds.length,
    },
    reservation: {
      id: hold.id,
      status: ReservationStatus.PAID,
    },
  })
  expect(payment.tickets).toHaveLength(seatIds.length)

  const tickets = await Promise.all(
    payment.tickets.map(async ({ id }) => {
      const response = await getTicket(id, identity)
      expect(response.statusCode).toBe(200)
      return response.json<TicketResponse>()
    }),
  )

  return { reservationId: hold.id, seatIds, payment, tickets }
}

async function removeCancellationFailureTrigger() {
  if (!databaseSafetyConfirmed) {
    return
  }

  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS "${CANCELLATION_FAILURE_TRIGGER}" ON "ReservationSeat"`,
  )
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS "${CANCELLATION_FAILURE_FUNCTION}"()`,
  )
  await prisma.$executeRawUnsafe(
    `DROP TABLE IF EXISTS "${CANCELLATION_FAILURE_TABLE}"`,
  )
  await prisma.$executeRawUnsafe(
    `DROP SEQUENCE IF EXISTS "${CANCELLATION_FAILURE_SEQUENCE}"`,
  )
}

async function installCancellationFailureTrigger(reservationSeatId: string) {
  if (!databaseSafetyConfirmed) {
    throw new Error('O banco local de teste não foi confirmado.')
  }

  await removeCancellationFailureTrigger()
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${CANCELLATION_FAILURE_TABLE}" (
      "reservationSeatId" UUID PRIMARY KEY
    )
  `)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${CANCELLATION_FAILURE_TABLE}" ("reservationSeatId") VALUES ($1::uuid)`,
    reservationSeatId,
  )
  await prisma.$executeRawUnsafe(
    `CREATE SEQUENCE "${CANCELLATION_FAILURE_SEQUENCE}"`,
  )
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${CANCELLATION_FAILURE_FUNCTION}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW."releasedAt" IS NOT NULL AND EXISTS (
        SELECT 1
        FROM "${CANCELLATION_FAILURE_TABLE}"
        WHERE "reservationSeatId" = NEW."id"
      ) THEN
        PERFORM nextval('"${CANCELLATION_FAILURE_SEQUENCE}"'::regclass);
        RAISE EXCEPTION 'controlled P0.1 reservation seat release failure';
      END IF;

      RETURN NEW;
    END;
    $function$
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${CANCELLATION_FAILURE_TRIGGER}"
    BEFORE UPDATE OF "releasedAt" ON "ReservationSeat"
    FOR EACH ROW
    EXECUTE FUNCTION "${CANCELLATION_FAILURE_FUNCTION}"()
  `)
}

async function removeCreatedSessions() {
  if (!databaseSafetyConfirmed || createdSessionIds.size === 0) {
    return
  }

  const sessionIds = Array.from(createdSessionIds)

  await prisma.sharedTicketLink.deleteMany({
    where: { ticket: { sessionId: { in: sessionIds } } },
  })
  await prisma.ticket.deleteMany({ where: { sessionId: { in: sessionIds } } })
  await prisma.payment.deleteMany({
    where: { reservation: { sessionId: { in: sessionIds } } },
  })
  await prisma.reservation.deleteMany({
    where: { sessionId: { in: sessionIds } },
  })
  await prisma.session.deleteMany({ where: { id: { in: sessionIds } } })
  createdSessionIds.clear()
}

async function waitForBlockedQueries(
  observer: Client,
  queryMarker: string,
  expectedCount = 1,
) {
  const deadline = Date.now() + 10_000

  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting_count: number }>(
      `
        SELECT COUNT(DISTINCT pid)::int AS waiting_count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE $1
      `,
      [`%${queryMarker}%`],
    )

    if ((result.rows[0]?.waiting_count ?? 0) >= expectedCount) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(
    `${expectedCount} requisição(ões) não chegaram ao lock esperado: ${queryMarker}.`,
  )
}

async function waitForBlockedSeatRequests(observer: Client, expectedCount: number) {
  const deadline = Date.now() + 10_000

  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting_count: number }>(`
      SELECT COUNT(DISTINCT pid)::int AS waiting_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "Seat"%'
        AND query LIKE '%FOR UPDATE%'
    `)

    if ((result.rows[0]?.waiting_count ?? 0) >= expectedCount) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(
    `${expectedCount} requisição(ões) não chegaram juntas ao lock do assento.`,
  )
}

beforeAll(async () => {
  assertLocalTestDatabase()
  await app.ready()

  const [organizer, customerOne, customerTwo, gate] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: 'organizer@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'customer1@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'customer2@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'gate@demo.local' } }),
  ])

  organizerId = organizer.id
  customerOneId = customerOne.id
  customerTwoId = customerTwo.id
  accessTokens.set(
    Role.ORGANIZER,
    app.jwt.sign({ role: Role.ORGANIZER, sub: organizer.id }),
  )
  accessTokens.set(
    Role.CUSTOMER,
    app.jwt.sign({ role: Role.CUSTOMER, sub: customerOne.id }),
  )
  accessTokens.set(
    'SECOND_CUSTOMER',
    app.jwt.sign({ role: Role.CUSTOMER, sub: customerTwo.id }),
  )
  accessTokens.set(
    Role.GATE,
    app.jwt.sign({ role: Role.GATE, sub: gate.id }),
  )

  await removeCancellationFailureTrigger()

  const oldSessions = await prisma.session.findMany({
    where: { address: TEST_SESSION_ADDRESS },
    select: { id: true },
  })

  for (const { id } of oldSessions) {
    createdSessionIds.add(id)
  }

  await removeCreatedSessions()
})

beforeEach(async () => {
  await removeCancellationFailureTrigger()
  await removeCreatedSessions()
})

afterAll(async () => {
  try {
    await removeCancellationFailureTrigger()
    await removeCreatedSessions()
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
})

describe('POST /reservations/:id/cancel lifecycle', () => {
  it('cancels a paid multi-seat purchase without erasing payment, tickets, allocations, or the old shared view', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const firstTicket = purchase.tickets[0]!
    const paymentBefore = await prisma.payment.findUniqueOrThrow({
      where: { reservationId: purchase.reservationId },
    })
    const allocationsBefore = await prisma.reservationSeat.findMany({
      where: { reservationId: purchase.reservationId },
      select: { id: true, seatId: true, releasedAt: true },
      orderBy: { seatId: 'asc' },
    })
    const shareResponse = await createShareLink(
      firstTicket.id,
      Role.CUSTOMER,
    )

    expect(shareResponse.statusCode).toBe(201)
    const shareUrl = shareResponse.json<{ url: string }>().url
    const shareToken = new URL(shareUrl).pathname.split('/').at(-1)
    expect(shareToken).toBeTruthy()
    expect(firstTicket.qrToken).not.toBeNull()
    expect(firstTicket.manualCode).not.toBeNull()

    const response = await cancelReservation(purchase.reservationId)

    expect(response.statusCode).toBe(200)
    const body = response.json<CancellationResponse>()
    expect(body.reservation).toEqual({
      id: purchase.reservationId,
      status: ReservationStatus.CANCELLED,
    })
    expect(body.tickets).toHaveLength(2)
    expect(body.tickets.map(({ id }) => id).sort()).toEqual(
      purchase.tickets.map(({ id }) => id).sort(),
    )
    expect(
      body.tickets.every(({ status }) => status === TicketStatus.CANCELLED),
    ).toBe(true)

    const [storedReservation, storedPayment, storedTickets, storedAllocations] =
      await Promise.all([
        prisma.reservation.findUniqueOrThrow({
          where: { id: purchase.reservationId },
        }),
        prisma.payment.findUniqueOrThrow({
          where: { reservationId: purchase.reservationId },
        }),
        prisma.ticket.findMany({
          where: { id: { in: purchase.tickets.map(({ id }) => id) } },
          orderBy: { id: 'asc' },
        }),
        prisma.reservationSeat.findMany({
          where: { reservationId: purchase.reservationId },
          select: { id: true, seatId: true, releasedAt: true },
          orderBy: { seatId: 'asc' },
        }),
      ])

    expect(storedReservation.status).toBe(ReservationStatus.CANCELLED)
    expect(storedPayment).toEqual(paymentBefore)
    expect(storedTickets).toHaveLength(2)
    expect(
      storedTickets.every(
        ({ status, usedAt, usedByGateId }) =>
          status === TicketStatus.CANCELLED &&
          usedAt === null &&
          usedByGateId === null,
      ),
    ).toBe(true)
    expect(storedAllocations.map(({ id }) => id)).toEqual(
      allocationsBefore.map(({ id }) => id),
    )
    expect(storedAllocations.every(({ releasedAt }) => releasedAt !== null)).toBe(
      true,
    )

    const privateTicketResponse = await getTicket(
      firstTicket.id,
      Role.CUSTOMER,
    )
    expect(privateTicketResponse.statusCode).toBe(200)
    expect(privateTicketResponse.json<TicketResponse>()).toMatchObject({
      id: firstTicket.id,
      status: TicketStatus.CANCELLED,
      manualCode: null,
      qrToken: null,
      reservation: {
        id: purchase.reservationId,
        status: ReservationStatus.CANCELLED,
        ticketCount: 2,
        canCancel: false,
      },
    })

    const privateListResponse = await app.inject({
      method: 'GET',
      url: '/me/tickets',
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(privateListResponse.statusCode).toBe(200)
    const cancelledPurchaseTickets = privateListResponse
      .json<{ tickets: TicketSummaryResponse[] }>()
      .tickets.filter(
        ({ reservation }) => reservation.id === purchase.reservationId,
      )
    expect(cancelledPurchaseTickets).toHaveLength(2)
    expect(
      cancelledPurchaseTickets.every(
        ({ status, manualCode, reservation }) =>
          status === TicketStatus.CANCELLED &&
          manualCode === null &&
          reservation.status === ReservationStatus.CANCELLED &&
          reservation.canCancel === false,
      ),
    ).toBe(true)

    const seatMapResponse = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/seats`,
    })
    expect(seatMapResponse.statusCode).toBe(200)
    const seatMap = seatMapResponse.json<SeatMapResponse>()
    for (const seatId of purchase.seatIds) {
      expect(seatMap.seats.find(({ id }) => id === seatId)?.status).toBe(
        'AVAILABLE',
      )
    }

    const [gateQr, gateManual] = await Promise.all([
      consumeTicket(session.id, firstTicket.qrToken!),
      consumeTicket(session.id, firstTicket.manualCode!),
    ])
    expect(gateQr.statusCode).toBe(200)
    expect(gateManual.statusCode).toBe(200)
    expect(gateQr.json<GateResponse>()).toEqual({ result: 'INVALID' })
    expect(gateManual.json<GateResponse>()).toEqual({ result: 'INVALID' })

    const sharedResponse = await app.inject({
      method: 'GET',
      url: `/shared/${shareToken!}`,
    })
    expect(sharedResponse.statusCode).toBe(200)
    const shared = sharedResponse.json<SharedTicketResponse>()
    expect(shared).toMatchObject({
      id: firstTicket.id,
      status: TicketStatus.CANCELLED,
      manualCode: null,
      qrToken: null,
    })
    expect(shared).not.toHaveProperty('reservation')
    expect(shared).not.toHaveProperty('owner')
    expect(shared).not.toHaveProperty('customer')
    expect(JSON.stringify(shared)).not.toContain('customer1@demo.local')
    expect(JSON.stringify(shared)).not.toMatch(
      /"(?:customer|customerId|email|owner|ownerId|reservation|reservationId)"\s*:/iu,
    )

    const newShare = await createShareLink(firstTicket.id, Role.CUSTOMER)
    expect(newShare.statusCode).toBe(409)
    expect(newShare.json()).toMatchObject({ error: 'TICKET_NOT_SHAREABLE' })

    const secondCustomerHold = await createHoldRequest(
      session.id,
      purchase.seatIds,
      'SECOND_CUSTOMER',
    )
    expect(secondCustomerHold.statusCode).toBe(201)

    const allocationsAfterRebooking = await prisma.reservationSeat.findMany({
      where: { seatId: { in: purchase.seatIds } },
      select: { reservationId: true, seatId: true, releasedAt: true },
      orderBy: [{ seatId: 'asc' }, { releasedAt: 'asc' }],
    })
    expect(allocationsAfterRebooking).toHaveLength(4)
    for (const seatId of purchase.seatIds) {
      const seatAllocations = allocationsAfterRebooking.filter(
        (allocation) => allocation.seatId === seatId,
      )
      expect(seatAllocations).toHaveLength(2)
      expect(
        seatAllocations.filter(({ releasedAt }) => releasedAt === null),
      ).toHaveLength(1)
      expect(
        seatAllocations.filter(({ releasedAt }) => releasedAt !== null),
      ).toHaveLength(1)
    }

    const repeatedCancellation = await cancelReservation(
      purchase.reservationId,
    )
    expect(repeatedCancellation.statusCode).toBe(409)
    expect(repeatedCancellation.json()).toMatchObject({
      error: 'RESERVATION_ALREADY_CANCELLED',
    })
  })

  it('retains multiple released allocations while the partial index permits exactly one active allocation', async () => {
    const session = await createTestSession(1)
    const seatId = session.seats[0]!.id
    const first = await createPaidPurchase(session, [0], Role.CUSTOMER)
    expect((await cancelReservation(first.reservationId)).statusCode).toBe(200)

    const second = await createPaidPurchase(session, [0], 'SECOND_CUSTOMER')
    expect(
      (await cancelReservation(second.reservationId, 'SECOND_CUSTOMER'))
        .statusCode,
    ).toBe(200)

    const active = await createSuccessfulHold(
      session.id,
      [seatId],
      Role.CUSTOMER,
    )
    const allocations = await prisma.reservationSeat.findMany({
      where: { seatId },
      select: { reservationId: true, releasedAt: true },
      orderBy: { releasedAt: 'asc' },
    })

    expect(allocations).toHaveLength(3)
    expect(allocations.filter(({ releasedAt }) => releasedAt !== null)).toHaveLength(
      2,
    )
    expect(allocations.filter(({ releasedAt }) => releasedAt === null)).toEqual([
      { reservationId: active.id, releasedAt: null },
    ])
    const [partialIndex] = await prisma.$queryRaw<
      Array<{
        isUnique: boolean
        isValid: boolean
        isReady: boolean
        predicate: string | null
      }>
    >`
      SELECT
        index_state.indisunique AS "isUnique",
        index_state.indisvalid AS "isValid",
        index_state.indisready AS "isReady",
        pg_get_expr(index_state.indpred, index_state.indrelid) AS "predicate"
      FROM pg_index AS index_state
      JOIN pg_class AS index_class
        ON index_class.oid = index_state.indexrelid
      JOIN pg_class AS table_class
        ON table_class.oid = index_state.indrelid
      JOIN pg_namespace AS namespace
        ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = current_schema()
        AND table_class.relname = 'ReservationSeat'
        AND index_class.relname = 'ReservationSeat_active_seatId_key'
    `
    expect(partialIndex).toMatchObject({
      isUnique: true,
      isValid: true,
      isReady: true,
    })
    expect(partialIndex?.predicate).toContain('"releasedAt" IS NULL')

    const reservationCountBefore = await prisma.reservation.count({
      where: { sessionId: session.id },
    })
    await expect(
      prisma.reservation.create({
        data: {
          customerId: requiredIds().customerTwoId,
          sessionId: session.id,
          expiresAt: futureDate(1),
          totalCents: SESSION_PRICE_CENTS,
          seats: {
            create: { seatId, unitPriceCents: SESSION_PRICE_CENTS },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(
      await prisma.reservation.count({ where: { sessionId: session.id } }),
    ).toBe(reservationCountBefore)
    expect(
      await prisma.reservationSeat.count({
        where: { seatId, releasedAt: null },
      }),
    ).toBe(1)
  })
})

describe('cancellation policy and authorization', () => {
  it('enforces authentication, CUSTOMER RBAC, ownership, UUID validation, and PAID-only policy', async () => {
    const session = await createTestSession(2)
    const pending = await createSuccessfulHold(session.id, [session.seats[0]!.id])
    const paid = await createPaidPurchase(session, [1])

    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/reservations/${paid.reservationId}/cancel`,
    })
    expect(unauthenticated.statusCode).toBe(401)

    for (const role of [Role.ORGANIZER, Role.GATE]) {
      const forbidden = await cancelReservation(paid.reservationId, role)
      expect(forbidden.statusCode).toBe(403)
    }

    const invalidId = await app.inject({
      method: 'POST',
      url: '/reservations/not-a-uuid/cancel',
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(invalidId.statusCode).toBe(400)
    expect(invalidId.json()).toMatchObject({ error: 'VALIDATION_ERROR' })

    const otherCustomer = await cancelReservation(
      paid.reservationId,
      'SECOND_CUSTOMER',
    )
    expect(otherCustomer.statusCode).toBe(404)
    expect(otherCustomer.json()).toMatchObject({
      error: 'RESERVATION_NOT_FOUND',
    })

    const pendingCancellation = await cancelReservation(pending.id)
    expect(pendingCancellation.statusCode).toBe(409)
    expect(pendingCancellation.json()).toMatchObject({
      error: 'RESERVATION_NOT_CANCELLABLE',
    })

    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: paid.reservationId },
        select: { status: true },
      }),
    ).toEqual({ status: ReservationStatus.PAID })
    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: pending.id },
        select: { status: true },
      }),
    ).toEqual({ status: ReservationStatus.PENDING })
  })

  it('rejects cancellation once the session has started without changing the purchase', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])

    await prisma.session.update({
      where: { id: session.id },
      data: { startsAt: new Date('2000-01-01T00:00:00.000Z') },
    })

    const response = await cancelReservation(purchase.reservationId)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: 'RESERVATION_SESSION_STARTED',
    })

    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: purchase.reservationId },
        select: { status: true },
      }),
    ).toEqual({ status: ReservationStatus.PAID })
    expect(
      await prisma.ticket.count({
        where: {
          id: { in: purchase.tickets.map(({ id }) => id) },
          status: TicketStatus.VALID,
        },
      }),
    ).toBe(2)
    expect(
      await prisma.reservationSeat.count({
        where: { reservationId: purchase.reservationId, releasedAt: null },
      }),
    ).toBe(2)
  })

  it('blocks the entire multi-seat cancellation when any ticket is USED', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const consumed = await consumeTicket(
      session.id,
      purchase.tickets[0]!.qrToken!,
    )
    expect(consumed.statusCode).toBe(200)
    expect(consumed.json<GateResponse>().result).toBe('VALID')

    const response = await cancelReservation(purchase.reservationId)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: 'RESERVATION_HAS_USED_TICKET',
    })

    const storedTickets = await prisma.ticket.findMany({
      where: { id: { in: purchase.tickets.map(({ id }) => id) } },
      select: { status: true },
      orderBy: { status: 'asc' },
    })
    expect(storedTickets.map(({ status }) => status).sort()).toEqual([
      TicketStatus.USED,
      TicketStatus.VALID,
    ].sort())
    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: purchase.reservationId },
        select: { status: true },
      }),
    ).toEqual({ status: ReservationStatus.PAID })
    expect(
      await prisma.reservationSeat.count({
        where: { reservationId: purchase.reservationId, releasedAt: null },
      }),
    ).toBe(2)

    const seatMap = (
      await app.inject({ method: 'GET', url: `/sessions/${session.id}/seats` })
    ).json<SeatMapResponse>()
    expect(
      seatMap.seats
        .filter(({ id }) => purchase.seatIds.includes(id))
        .every(({ status }) => status === 'SOLD'),
    ).toBe(true)
  })
})

describe('cancellation atomicity and deterministic concurrency', () => {
  it(
    'allows exactly one winner when two cancellations contend for the same purchase',
    async () => {
      const session = await createTestSession()
      const purchase = await createPaidPurchase(session, [0])
      const connectionString = process.env.DATABASE_URL!
      const blocker = new Client({ connectionString })
      const observer = new Client({ connectionString })
      let blockerConnected = false
      let observerConnected = false
      let blockerTransactionOpen = false
      const requests: Array<ReturnType<typeof cancelReservation>> = []

      try {
        await blocker.connect()
        blockerConnected = true
        await observer.connect()
        observerConnected = true
        await blocker.query('BEGIN')
        blockerTransactionOpen = true
        await blocker.query(
          'SELECT "id" FROM "Seat" WHERE "id" = $1::uuid FOR UPDATE',
          [purchase.seatIds[0]],
        )

        requests.push(
          cancelReservation(purchase.reservationId),
          cancelReservation(purchase.reservationId),
        )
        await waitForBlockedQueries(
          observer,
          'cancel-reservation-lock-seats',
          2,
        )

        await blocker.query('COMMIT')
        blockerTransactionOpen = false

        const responses = await Promise.all(requests)
        expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([
          200,
          409,
        ])
        expect(
          responses.find(({ statusCode }) => statusCode === 409)?.json(),
        ).toMatchObject({ error: 'RESERVATION_ALREADY_CANCELLED' })
        expect(
          await prisma.reservationSeat.count({
            where: {
              reservationId: purchase.reservationId,
              releasedAt: { not: null },
            },
          }),
        ).toBe(1)
        expect(
          await prisma.ticket.count({
            where: {
              id: purchase.tickets[0]!.id,
              status: TicketStatus.CANCELLED,
            },
          }),
        ).toBe(1)
      } finally {
        if (blockerTransactionOpen && blockerConnected) {
          await Promise.allSettled([blocker.query('ROLLBACK')])
        }
        await Promise.allSettled(requests)
        await Promise.allSettled([
          blockerConnected ? blocker.end() : Promise.resolve(),
          observerConnected ? observer.end() : Promise.resolve(),
        ])
      }
    },
    15_000,
  )

  it.each([
    { first: 'gate' as const },
    { first: 'cancel' as const },
  ])(
    'linearizes Gate x cancellation when $first reaches the ticket lock first',
    async ({ first }) => {
      const session = await createTestSession()
      const purchase = await createPaidPurchase(session, [0])
      const ticket = purchase.tickets[0]!
      const connectionString = process.env.DATABASE_URL!
      const blocker = new Client({ connectionString })
      const observer = new Client({ connectionString })
      let blockerConnected = false
      let observerConnected = false
      let blockerTransactionOpen = false
      let gateRequest: ReturnType<typeof consumeTicket> | null = null
      let cancellationRequest: ReturnType<typeof cancelReservation> | null = null

      try {
        await blocker.connect()
        blockerConnected = true
        await observer.connect()
        observerConnected = true
        await blocker.query('BEGIN')
        blockerTransactionOpen = true
        await blocker.query(
          'SELECT "id" FROM "Ticket" WHERE "id" = $1::uuid FOR UPDATE',
          [ticket.id],
        )

        if (first === 'gate') {
          gateRequest = consumeTicket(session.id, ticket.qrToken!)
          await waitForBlockedQueries(observer, 'gate-consume-ticket')
          cancellationRequest = cancelReservation(purchase.reservationId)
          await waitForBlockedQueries(
            observer,
            'cancel-reservation-lock-tickets',
          )
        } else {
          cancellationRequest = cancelReservation(purchase.reservationId)
          await waitForBlockedQueries(
            observer,
            'cancel-reservation-lock-tickets',
          )
          gateRequest = consumeTicket(session.id, ticket.qrToken!)
          await waitForBlockedQueries(observer, 'gate-consume-ticket')
        }

        await blocker.query('COMMIT')
        blockerTransactionOpen = false

        const [gateResponse, cancellationResponse] = await Promise.all([
          gateRequest,
          cancellationRequest,
        ])
        expect(gateResponse).not.toBeNull()
        expect(cancellationResponse).not.toBeNull()

        const storedReservation = await prisma.reservation.findUniqueOrThrow({
          where: { id: purchase.reservationId },
          select: { status: true },
        })
        const storedTicket = await prisma.ticket.findUniqueOrThrow({
          where: { id: ticket.id },
          select: { status: true, usedAt: true, usedByGateId: true },
        })
        const storedAllocation = await prisma.reservationSeat.findFirstOrThrow({
          where: { reservationId: purchase.reservationId },
          select: { releasedAt: true },
        })

        if (first === 'gate') {
          expect(gateResponse!.statusCode).toBe(200)
          expect(gateResponse!.json<GateResponse>().result).toBe('VALID')
          expect(cancellationResponse!.statusCode).toBe(409)
          expect(cancellationResponse!.json()).toMatchObject({
            error: 'RESERVATION_HAS_USED_TICKET',
          })
          expect(storedReservation.status).toBe(ReservationStatus.PAID)
          expect(storedTicket.status).toBe(TicketStatus.USED)
          expect(storedTicket.usedAt).not.toBeNull()
          expect(storedTicket.usedByGateId).not.toBeNull()
          expect(storedAllocation.releasedAt).toBeNull()
        } else {
          expect(cancellationResponse!.statusCode).toBe(200)
          expect(gateResponse!.statusCode).toBe(200)
          expect(gateResponse!.json<GateResponse>()).toEqual({ result: 'INVALID' })
          expect(storedReservation.status).toBe(ReservationStatus.CANCELLED)
          expect(storedTicket).toEqual({
            status: TicketStatus.CANCELLED,
            usedAt: null,
            usedByGateId: null,
          })
          expect(storedAllocation.releasedAt).not.toBeNull()
        }
      } finally {
        if (blockerTransactionOpen && blockerConnected) {
          await Promise.allSettled([blocker.query('ROLLBACK')])
        }
        await Promise.allSettled(
          [gateRequest, cancellationRequest].filter(
            (request): request is NonNullable<typeof request> => request !== null,
          ),
        )
        await Promise.allSettled([
          blockerConnected ? blocker.end() : Promise.resolve(),
          observerConnected ? observer.end() : Promise.resolve(),
        ])
      }
    },
    15_000,
  )

  it(
    'serializes cancellation with a replacement hold and never exposes two active allocations',
    async () => {
      const session = await createTestSession()
      const purchase = await createPaidPurchase(session, [0])
      const seatId = purchase.seatIds[0]!
      const connectionString = process.env.DATABASE_URL!
      const blocker = new Client({ connectionString })
      const observer = new Client({ connectionString })
      let blockerConnected = false
      let observerConnected = false
      let blockerTransactionOpen = false
      let cancellationRequest: ReturnType<typeof cancelReservation> | null = null
      let replacementRequest: ReturnType<typeof createHoldRequest> | null = null

      try {
        await blocker.connect()
        blockerConnected = true
        await observer.connect()
        observerConnected = true
        await blocker.query('BEGIN')
        blockerTransactionOpen = true
        await blocker.query(
          'SELECT "id" FROM "Seat" WHERE "id" = $1::uuid FOR UPDATE',
          [seatId],
        )

        cancellationRequest = cancelReservation(purchase.reservationId)
        await waitForBlockedQueries(
          observer,
          'cancel-reservation-lock-seats',
        )
        replacementRequest = createHoldRequest(
          session.id,
          [seatId],
          'SECOND_CUSTOMER',
        )
        await waitForBlockedSeatRequests(observer, 2)

        await blocker.query('COMMIT')
        blockerTransactionOpen = false

        const [cancellation, replacement] = await Promise.all([
          cancellationRequest,
          replacementRequest,
        ])
        expect(cancellation.statusCode).toBe(200)
        expect(replacement.statusCode).toBe(201)
        const replacementHold = replacement.json<HoldResponse>()

        const allocations = await prisma.reservationSeat.findMany({
          where: { seatId },
          select: { reservationId: true, releasedAt: true },
        })
        expect(allocations).toHaveLength(2)
        expect(
          allocations.filter(({ releasedAt }) => releasedAt !== null),
        ).toHaveLength(1)
        expect(allocations.filter(({ releasedAt }) => releasedAt === null)).toEqual([
          { reservationId: replacementHold.id, releasedAt: null },
        ])
      } finally {
        if (blockerTransactionOpen && blockerConnected) {
          await Promise.allSettled([blocker.query('ROLLBACK')])
        }
        await Promise.allSettled(
          [cancellationRequest, replacementRequest].filter(
            (request): request is NonNullable<typeof request> => request !== null,
          ),
        )
        await Promise.allSettled([
          blockerConnected ? blocker.end() : Promise.resolve(),
          observerConnected ? observer.end() : Promise.resolve(),
        ])
      }
    },
    15_000,
  )

  it('rolls back tickets, reservation, and every allocation when releasing one seat fails', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const allocations = await prisma.reservationSeat.findMany({
      where: { reservationId: purchase.reservationId },
      select: { id: true },
      orderBy: { seatId: 'asc' },
    })
    await installCancellationFailureTrigger(allocations[1]!.id)

    try {
      const response = await cancelReservation(purchase.reservationId)
      expect(response.statusCode).toBe(500)
      const [failureHit] = await prisma.$queryRawUnsafe<
        Array<{ value: number; isCalled: boolean }>
      >(
        `SELECT last_value::int AS "value", is_called AS "isCalled" FROM "${CANCELLATION_FAILURE_SEQUENCE}"`,
      )
      expect(failureHit).toEqual({ value: 1, isCalled: true })

      expect(
        await prisma.reservation.findUniqueOrThrow({
          where: { id: purchase.reservationId },
          select: { status: true },
        }),
      ).toEqual({ status: ReservationStatus.PAID })
      expect(
        await prisma.payment.findUniqueOrThrow({
          where: { reservationId: purchase.reservationId },
          select: { status: true, amountCents: true },
        }),
      ).toEqual({
        status: PaymentStatus.APPROVED,
        amountCents: SESSION_PRICE_CENTS * 2,
      })
      expect(
        await prisma.ticket.count({
          where: {
            id: { in: purchase.tickets.map(({ id }) => id) },
            status: TicketStatus.VALID,
          },
        }),
      ).toBe(2)
      expect(
        await prisma.reservationSeat.count({
          where: { reservationId: purchase.reservationId, releasedAt: null },
        }),
      ).toBe(2)

      const ticketAfterRollback = await getTicket(
        purchase.tickets[0]!.id,
        Role.CUSTOMER,
      )
      expect(ticketAfterRollback.statusCode).toBe(200)
      expect(ticketAfterRollback.json<TicketResponse>()).toMatchObject({
        status: TicketStatus.VALID,
        reservation: {
          id: purchase.reservationId,
          status: ReservationStatus.PAID,
          canCancel: true,
        },
      })

      const seatMap = (
        await app.inject({ method: 'GET', url: `/sessions/${session.id}/seats` })
      ).json<SeatMapResponse>()
      expect(
        seatMap.seats
          .filter(({ id }) => purchase.seatIds.includes(id))
          .every(({ status }) => status === 'SOLD'),
      ).toBe(true)
    } finally {
      await removeCancellationFailureTrigger()
    }
  })
})
