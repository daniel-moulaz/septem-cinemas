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

const TEST_SESSION_ADDRESS = 'Rua do Cancelamento Individual, 401 — teste P0.1B'
const SESSION_PRICE_CENTS = 3_800
const FAILURE_TRIGGER = 'P01B_fail_reservation_seat_release'
const FAILURE_FUNCTION = 'P01B_fail_reservation_seat_release_function'
const FAILURE_TABLE = 'P01BCancellationFailure'
const FAILURE_SEQUENCE = 'P01BCancellationFailureHit'

interface TestSession {
  id: string
  seats: Array<{ id: string; label: string }>
}

interface HoldResponse {
  id: string
  status: ReservationStatus
}

interface PaymentResponse {
  payment: { id: string; status: PaymentStatus; amountCents: number }
  reservation: { id: string; status: ReservationStatus }
  tickets: Array<{ id: string }>
}

interface TicketReservationView {
  id: string
  status: ReservationStatus
  ticketCount: number
  canCancel: boolean
}

interface TicketResponse {
  id: string
  status: TicketStatus
  manualCode: string | null
  qrToken: string | null
  canCancel: boolean
  seat: { id: string; label: string }
  reservation: TicketReservationView
}

interface TicketCancellationResponse {
  ticket: { id: string; status: TicketStatus }
  reservation: { id: string; status: ReservationStatus }
}

interface ReservationCancellationResponse {
  reservation: { id: string; status: ReservationStatus }
  tickets: Array<{ id: string; status: TicketStatus }>
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
      'Os testes de cancelamento individual exigem NODE_ENV=test e DATABASE_URL local.',
    )
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error(
      'Os testes de cancelamento individual recusaram um PostgreSQL não local.',
    )
  }

  databaseSafetyConfirmed = true
}

function requiredIds() {
  if (!organizerId || !customerOneId || !customerTwoId) {
    throw new Error(
      'Os usuários dos testes de cancelamento individual não foram inicializados.',
    )
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

async function createTestSession(seatCount = 2): Promise<TestSession> {
  const session = await prisma.session.create({
    data: {
      organizerId: requiredIds().organizerId,
      status: SessionStatus.PUBLISHED,
      startsAt: futureDate(),
      venueName: 'Cine Cancelamento Individual',
      roomName: 'Sala Fragmento',
      address: TEST_SESSION_ADDRESS,
      priceCents: SESSION_PRICE_CENTS,
      tmdbMovieId: 801,
      movieTitle: 'O Assento Fica',
      movieOverview: 'Sessão criada exclusivamente pela suíte P0.1B.',
      moviePosterPath: '/p01b-poster.jpg',
      movieBackdropPath: null,
      movieReleaseDate: new Date('2026-02-01T00:00:00.000Z'),
      movieRuntimeMinutes: 98,
      publishedAt: new Date(),
      seats: {
        create: Array.from({ length: seatCount }, (_, index) => ({
          rowLabel: 'B',
          number: index + 1,
          label: `B${index + 1}`,
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

function cancelTicket(ticketId: string, identity: AuthIdentity = Role.CUSTOMER) {
  return app.inject({
    method: 'POST',
    url: `/me/tickets/${ticketId}/cancel`,
    headers: authorization(tokenFor(identity)),
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
  expect(payment.tickets).toHaveLength(seatIds.length)

  const unorderedTickets = await Promise.all(
    payment.tickets.map(async ({ id }) => {
      const response = await getTicket(id, identity)
      expect(response.statusCode).toBe(200)
      return response.json<TicketResponse>()
    }),
  )

  // A API cria os tickets ordenados por seatId (UUID), não pela ordem de
  // seatIds informada na reserva. Reordena para que tickets[n] corresponda
  // sempre a seatIds[n], como os testes abaixo assumem.
  const tickets = seatIds.map(
    (seatId) => unorderedTickets.find((ticket) => ticket.seat.id === seatId)!,
  )

  return { reservationId: hold.id, seatIds, payment, tickets }
}

async function removeFailureTrigger() {
  if (!databaseSafetyConfirmed) {
    return
  }

  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS "${FAILURE_TRIGGER}" ON "ReservationSeat"`,
  )
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${FAILURE_FUNCTION}"()`)
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${FAILURE_TABLE}"`)
  await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${FAILURE_SEQUENCE}"`)
}

async function installFailureTrigger(reservationSeatId: string) {
  if (!databaseSafetyConfirmed) {
    throw new Error('O banco local de teste não foi confirmado.')
  }

  await removeFailureTrigger()
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${FAILURE_TABLE}" ("reservationSeatId" UUID PRIMARY KEY)
  `)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${FAILURE_TABLE}" ("reservationSeatId") VALUES ($1::uuid)`,
    reservationSeatId,
  )
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${FAILURE_SEQUENCE}"`)
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${FAILURE_FUNCTION}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW."releasedAt" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "${FAILURE_TABLE}" WHERE "reservationSeatId" = NEW."id"
      ) THEN
        PERFORM nextval('"${FAILURE_SEQUENCE}"'::regclass);
        RAISE EXCEPTION 'controlled P0.1B ticket release failure';
      END IF;

      RETURN NEW;
    END;
    $function$
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${FAILURE_TRIGGER}"
    BEFORE UPDATE OF "releasedAt" ON "ReservationSeat"
    FOR EACH ROW
    EXECUTE FUNCTION "${FAILURE_FUNCTION}"()
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
  accessTokens.set(Role.GATE, app.jwt.sign({ role: Role.GATE, sub: gate.id }))

  await removeFailureTrigger()

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
  await removeFailureTrigger()
  await removeCreatedSessions()
})

afterAll(async () => {
  try {
    await removeFailureTrigger()
    await removeCreatedSessions()
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
})

describe('POST /me/tickets/:id/cancel lifecycle', () => {
  it('cancels only the targeted ticket, leaving the sibling ticket, the reservation, and history intact', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [firstTicket, secondTicket] = purchase.tickets as [
      TicketResponse,
      TicketResponse,
    ]
    const allocationsBefore = await prisma.reservationSeat.findMany({
      where: { reservationId: purchase.reservationId },
      select: { id: true, seatId: true, releasedAt: true },
      orderBy: { seatId: 'asc' },
    })

    const response = await cancelTicket(firstTicket.id)

    expect(response.statusCode).toBe(200)
    const body = response.json<TicketCancellationResponse>()
    expect(body).toEqual({
      ticket: { id: firstTicket.id, status: TicketStatus.CANCELLED },
      reservation: { id: purchase.reservationId, status: ReservationStatus.PAID },
    })

    const [storedReservation, storedTickets, storedAllocations] = await Promise.all([
      prisma.reservation.findUniqueOrThrow({
        where: { id: purchase.reservationId },
      }),
      prisma.ticket.findMany({
        where: { id: { in: [firstTicket.id, secondTicket.id] } },
        orderBy: { id: 'asc' },
      }),
      prisma.reservationSeat.findMany({
        where: { reservationId: purchase.reservationId },
        select: { id: true, seatId: true, releasedAt: true },
        orderBy: { seatId: 'asc' },
      }),
    ])

    expect(storedReservation.status).toBe(ReservationStatus.PAID)
    expect(
      storedTickets.find(({ id }) => id === firstTicket.id),
    ).toMatchObject({ status: TicketStatus.CANCELLED, usedAt: null, usedByGateId: null })
    expect(
      storedTickets.find(({ id }) => id === secondTicket.id),
    ).toMatchObject({ status: TicketStatus.VALID })
    expect(storedAllocations.map(({ id }) => id)).toEqual(
      allocationsBefore.map(({ id }) => id),
    )

    const firstAllocation = storedAllocations.find(
      (allocation) => allocation.seatId === purchase.seatIds[0],
    )
    const secondAllocation = storedAllocations.find(
      (allocation) => allocation.seatId === purchase.seatIds[1],
    )
    expect(firstAllocation?.releasedAt).not.toBeNull()
    expect(secondAllocation?.releasedAt).toBeNull()

    const seatMapResponse = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/seats`,
    })
    const seatMap = seatMapResponse.json<SeatMapResponse>()
    expect(
      seatMap.seats.find(({ id }) => id === purchase.seatIds[0])?.status,
    ).toBe('AVAILABLE')
    expect(
      seatMap.seats.find(({ id }) => id === purchase.seatIds[1])?.status,
    ).toBe('SOLD')

    const refreshedFirst = (
      await getTicket(firstTicket.id, Role.CUSTOMER)
    ).json<TicketResponse>()
    const refreshedSecond = (
      await getTicket(secondTicket.id, Role.CUSTOMER)
    ).json<TicketResponse>()
    expect(refreshedFirst).toMatchObject({
      status: TicketStatus.CANCELLED,
      manualCode: null,
      qrToken: null,
      canCancel: false,
      reservation: {
        status: ReservationStatus.PAID,
        ticketCount: 2,
      },
    })
    expect(refreshedSecond).toMatchObject({
      status: TicketStatus.VALID,
      canCancel: true,
      reservation: {
        status: ReservationStatus.PAID,
        ticketCount: 2,
        canCancel: true,
      },
    })
  })

  it('lets a second customer reserve exactly the freed seat while the sibling seat remains booked', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [firstTicket] = purchase.tickets as [TicketResponse, TicketResponse]

    expect((await cancelTicket(firstTicket.id)).statusCode).toBe(200)

    const conflictOnSold = await createHoldRequest(
      session.id,
      [purchase.seatIds[1]!],
      'SECOND_CUSTOMER',
    )
    expect(conflictOnSold.statusCode).toBe(409)

    const replacementHold = await createSuccessfulHold(
      session.id,
      [purchase.seatIds[0]!],
      'SECOND_CUSTOMER',
    )
    expect(replacementHold.status).toBe(ReservationStatus.PENDING)

    const allocations = await prisma.reservationSeat.findMany({
      where: { seatId: purchase.seatIds[0]! },
      select: { reservationId: true, releasedAt: true },
    })
    expect(allocations).toHaveLength(2)
    expect(allocations.filter(({ releasedAt }) => releasedAt === null)).toEqual([
      { reservationId: replacementHold.id, releasedAt: null },
    ])
  })

  it('invalidates the cancelled ticket credentials at the Gate while the sibling ticket stays valid', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [firstTicket, secondTicket] = purchase.tickets as [
      TicketResponse,
      TicketResponse,
    ]

    expect((await cancelTicket(firstTicket.id)).statusCode).toBe(200)

    const [gateQr, gateManual, gateSecond] = await Promise.all([
      consumeTicket(session.id, firstTicket.qrToken!),
      consumeTicket(session.id, firstTicket.manualCode!),
      consumeTicket(session.id, secondTicket.qrToken!),
    ])

    expect(gateQr.json<GateResponse>()).toEqual({ result: 'INVALID' })
    expect(gateManual.json<GateResponse>()).toEqual({ result: 'INVALID' })
    expect(gateSecond.json<GateResponse>()).toMatchObject({ result: 'VALID' })
  })

  it('neutralizes sharing for the cancelled ticket while the sibling ticket keeps sharing normally', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [firstTicket, secondTicket] = purchase.tickets as [
      TicketResponse,
      TicketResponse,
    ]

    const firstShare = await createShareLink(firstTicket.id, Role.CUSTOMER)
    const secondShare = await createShareLink(secondTicket.id, Role.CUSTOMER)
    expect(firstShare.statusCode).toBe(201)
    expect(secondShare.statusCode).toBe(201)
    const firstToken = new URL(
      firstShare.json<{ url: string }>().url,
    ).pathname.split('/').at(-1)!
    const secondToken = new URL(
      secondShare.json<{ url: string }>().url,
    ).pathname.split('/').at(-1)!

    expect((await cancelTicket(firstTicket.id)).statusCode).toBe(200)

    const sharedFirst = (
      await app.inject({ method: 'GET', url: `/shared/${firstToken}` })
    ).json<SharedTicketResponse>()
    expect(sharedFirst).toMatchObject({
      status: TicketStatus.CANCELLED,
      manualCode: null,
      qrToken: null,
    })

    const sharedSecond = (
      await app.inject({ method: 'GET', url: `/shared/${secondToken}` })
    ).json<SharedTicketResponse>()
    expect(sharedSecond).toMatchObject({ status: TicketStatus.VALID })
    expect(sharedSecond.manualCode).not.toBeNull()
    expect(sharedSecond.qrToken).not.toBeNull()

    const newShareOnCancelled = await createShareLink(firstTicket.id, Role.CUSTOMER)
    expect(newShareOnCancelled.statusCode).toBe(409)
    expect(newShareOnCancelled.json()).toMatchObject({
      error: 'TICKET_NOT_SHAREABLE',
    })

    const newShareOnValid = await createShareLink(secondTicket.id, Role.CUSTOMER)
    expect(newShareOnValid.statusCode).toBe(201)
  })
})

describe('individual cancellation policy and authorization', () => {
  it('enforces authentication, CUSTOMER RBAC, ownership, UUID validation, and VALID-only policy', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [firstTicket] = purchase.tickets as [TicketResponse, TicketResponse]

    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/me/tickets/${firstTicket.id}/cancel`,
    })
    expect(unauthenticated.statusCode).toBe(401)

    for (const role of [Role.ORGANIZER, Role.GATE]) {
      expect((await cancelTicket(firstTicket.id, role)).statusCode).toBe(403)
    }

    const invalidId = await app.inject({
      method: 'POST',
      url: '/me/tickets/not-a-uuid/cancel',
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(invalidId.statusCode).toBe(400)
    expect(invalidId.json()).toMatchObject({ error: 'VALIDATION_ERROR' })

    const otherCustomer = await cancelTicket(firstTicket.id, 'SECOND_CUSTOMER')
    expect(otherCustomer.statusCode).toBe(404)
    expect(otherCustomer.json()).toMatchObject({ error: 'TICKET_NOT_FOUND' })

    expect(
      await prisma.ticket.findUniqueOrThrow({
        where: { id: firstTicket.id },
        select: { status: true },
      }),
    ).toEqual({ status: TicketStatus.VALID })

    expect((await cancelTicket(firstTicket.id)).statusCode).toBe(200)

    const doubleCancel = await cancelTicket(firstTicket.id)
    expect(doubleCancel.statusCode).toBe(409)
    expect(doubleCancel.json()).toMatchObject({ error: 'TICKET_NOT_CANCELLABLE' })
  })

  it('rejects cancellation once the session has started without changing the ticket', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [firstTicket] = purchase.tickets as [TicketResponse, TicketResponse]

    await prisma.session.update({
      where: { id: session.id },
      data: { startsAt: new Date('2000-01-01T00:00:00.000Z') },
    })

    const response = await cancelTicket(firstTicket.id)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'TICKET_SESSION_STARTED' })

    expect(
      await prisma.ticket.findUniqueOrThrow({
        where: { id: firstTicket.id },
        select: { status: true },
      }),
    ).toEqual({ status: TicketStatus.VALID })
    expect(
      await prisma.reservationSeat.count({
        where: { reservationId: purchase.reservationId, releasedAt: null },
      }),
    ).toBe(2)
  })

  it('blocks cancellation of an already USED ticket', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [firstTicket] = purchase.tickets as [TicketResponse, TicketResponse]

    const consumed = await consumeTicket(session.id, firstTicket.qrToken!)
    expect(consumed.json<GateResponse>().result).toBe('VALID')

    const response = await cancelTicket(firstTicket.id)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'TICKET_NOT_CANCELLABLE' })

    expect(
      await prisma.ticket.findUniqueOrThrow({
        where: { id: firstTicket.id },
        select: { status: true },
      }),
    ).toEqual({ status: TicketStatus.USED })
    expect(
      await prisma.reservationSeat.count({
        where: { reservationId: purchase.reservationId, releasedAt: null },
      }),
    ).toBe(2)
  })

  it('cancels the last remaining VALID ticket of a purchase and closes the reservation', async () => {
    const session = await createTestSession(1)
    const purchase = await createPaidPurchase(session, [0])
    const [onlyTicket] = purchase.tickets as [TicketResponse]

    const response = await cancelTicket(onlyTicket.id)
    expect(response.statusCode).toBe(200)
    expect(response.json<TicketCancellationResponse>()).toEqual({
      ticket: { id: onlyTicket.id, status: TicketStatus.CANCELLED },
      reservation: { id: purchase.reservationId, status: ReservationStatus.CANCELLED },
    })

    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: purchase.reservationId },
        select: { status: true },
      }),
    ).toEqual({ status: ReservationStatus.CANCELLED })

    const secondCustomerHold = await createHoldRequest(
      session.id,
      purchase.seatIds,
      'SECOND_CUSTOMER',
    )
    expect(secondCustomerHold.statusCode).toBe(201)
  })

  it('keeps the reservation PAID when a USED ticket coexists with the one just cancelled', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [usedTicket, cancelledTicket] = purchase.tickets as [
      TicketResponse,
      TicketResponse,
    ]

    const consumed = await consumeTicket(session.id, usedTicket.qrToken!)
    expect(consumed.json<GateResponse>().result).toBe('VALID')

    const response = await cancelTicket(cancelledTicket.id)
    expect(response.statusCode).toBe(200)
    expect(response.json<TicketCancellationResponse>()).toEqual({
      ticket: { id: cancelledTicket.id, status: TicketStatus.CANCELLED },
      reservation: { id: purchase.reservationId, status: ReservationStatus.PAID },
    })

    const [storedReservation, storedPayment, storedTickets, storedAllocations] =
      await Promise.all([
        prisma.reservation.findUniqueOrThrow({
          where: { id: purchase.reservationId },
        }),
        prisma.payment.findUniqueOrThrow({
          where: { reservationId: purchase.reservationId },
        }),
        prisma.ticket.findMany({
          where: { id: { in: [usedTicket.id, cancelledTicket.id] } },
          select: { id: true, status: true },
        }),
        prisma.reservationSeat.findMany({
          where: { reservationId: purchase.reservationId },
          select: { seatId: true, releasedAt: true },
        }),
      ])

    expect(storedReservation.status).toBe(ReservationStatus.PAID)
    expect(storedPayment.status).toBe(PaymentStatus.APPROVED)
    expect(
      storedTickets.find(({ id }) => id === usedTicket.id),
    ).toMatchObject({ status: TicketStatus.USED })
    expect(
      storedTickets.find(({ id }) => id === cancelledTicket.id),
    ).toMatchObject({ status: TicketStatus.CANCELLED })
    expect(
      storedAllocations.find(({ seatId }) => seatId === usedTicket.seat.id)
        ?.releasedAt,
    ).toBeNull()
    expect(
      storedAllocations.find(({ seatId }) => seatId === cancelledTicket.seat.id)
        ?.releasedAt,
    ).not.toBeNull()

    const gateOnUsed = await consumeTicket(session.id, usedTicket.qrToken!)
    expect(gateOnUsed.json<GateResponse>().result).toBe('ALREADY_USED')

    const gateOnCancelledQr = await consumeTicket(
      session.id,
      cancelledTicket.qrToken!,
    )
    const gateOnCancelledManual = await consumeTicket(
      session.id,
      cancelledTicket.manualCode!,
    )
    expect(gateOnCancelledQr.json<GateResponse>()).toEqual({ result: 'INVALID' })
    expect(gateOnCancelledManual.json<GateResponse>()).toEqual({
      result: 'INVALID',
    })

    const integralCancel = await cancelReservation(purchase.reservationId)
    expect(integralCancel.statusCode).toBe(409)
    expect(integralCancel.json()).toMatchObject({
      error: 'RESERVATION_HAS_USED_TICKET',
    })
    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: purchase.reservationId },
        select: { status: true },
      }),
    ).toEqual({ status: ReservationStatus.PAID })
  })

  it('lets the integral cancellation finish the remaining tickets of a partially cancelled purchase', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [firstTicket, secondTicket] = purchase.tickets as [
      TicketResponse,
      TicketResponse,
    ]

    expect((await cancelTicket(firstTicket.id)).statusCode).toBe(200)

    const response = await cancelReservation(purchase.reservationId)
    expect(response.statusCode).toBe(200)
    const body = response.json<ReservationCancellationResponse>()

    expect(body.reservation).toEqual({
      id: purchase.reservationId,
      status: ReservationStatus.CANCELLED,
    })
    expect(body.tickets).toEqual([
      { id: secondTicket.id, status: TicketStatus.CANCELLED },
    ])

    const storedTickets = await prisma.ticket.findMany({
      where: { id: { in: [firstTicket.id, secondTicket.id] } },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    })
    expect(
      storedTickets.every(({ status }) => status === TicketStatus.CANCELLED),
    ).toBe(true)
    expect(
      await prisma.reservationSeat.count({
        where: { reservationId: purchase.reservationId, releasedAt: null },
      }),
    ).toBe(0)

    const repeatedIntegralCancel = await cancelReservation(purchase.reservationId)
    expect(repeatedIntegralCancel.statusCode).toBe(409)
    expect(repeatedIntegralCancel.json()).toMatchObject({
      error: 'RESERVATION_ALREADY_CANCELLED',
    })
  })
})

describe('individual cancellation atomicity and deterministic concurrency', () => {
  it.each([
    { first: 'gate' as const },
    { first: 'cancel' as const },
  ])(
    'linearizes Gate x individual cancellation when $first reaches the ticket lock first',
    async ({ first }) => {
      const session = await createTestSession()
      const purchase = await createPaidPurchase(session, [0, 1])
      const [firstTicket] = purchase.tickets as [TicketResponse, TicketResponse]
      const connectionString = process.env.DATABASE_URL!
      const blocker = new Client({ connectionString })
      const observer = new Client({ connectionString })
      let blockerConnected = false
      let observerConnected = false
      let blockerTransactionOpen = false
      let gateRequest: ReturnType<typeof consumeTicket> | null = null
      let cancellationRequest: ReturnType<typeof cancelTicket> | null = null

      try {
        await blocker.connect()
        blockerConnected = true
        await observer.connect()
        observerConnected = true
        await blocker.query('BEGIN')
        blockerTransactionOpen = true
        await blocker.query(
          'SELECT "id" FROM "Ticket" WHERE "id" = $1::uuid FOR UPDATE',
          [firstTicket.id],
        )

        if (first === 'gate') {
          gateRequest = consumeTicket(session.id, firstTicket.qrToken!)
          await waitForBlockedQueries(observer, 'gate-consume-ticket')
          cancellationRequest = cancelTicket(firstTicket.id)
          await waitForBlockedQueries(observer, 'cancel-ticket-lock-ticket')
        } else {
          cancellationRequest = cancelTicket(firstTicket.id)
          await waitForBlockedQueries(observer, 'cancel-ticket-lock-ticket')
          gateRequest = consumeTicket(session.id, firstTicket.qrToken!)
          await waitForBlockedQueries(observer, 'gate-consume-ticket')
        }

        await blocker.query('COMMIT')
        blockerTransactionOpen = false

        const [gateResponse, cancellationResponse] = await Promise.all([
          gateRequest,
          cancellationRequest,
        ])

        const storedTicket = await prisma.ticket.findUniqueOrThrow({
          where: { id: firstTicket.id },
          select: { status: true, usedAt: true, usedByGateId: true },
        })
        const storedAllocation = await prisma.reservationSeat.findFirstOrThrow({
          where: { reservationId: purchase.reservationId, seatId: purchase.seatIds[0]! },
          select: { releasedAt: true },
        })

        if (first === 'gate') {
          expect(gateResponse.statusCode).toBe(200)
          expect(gateResponse.json<GateResponse>().result).toBe('VALID')
          expect(cancellationResponse.statusCode).toBe(409)
          expect(cancellationResponse.json()).toMatchObject({
            error: 'TICKET_NOT_CANCELLABLE',
          })
          expect(storedTicket.status).toBe(TicketStatus.USED)
          expect(storedTicket.usedAt).not.toBeNull()
          expect(storedAllocation.releasedAt).toBeNull()
        } else {
          expect(cancellationResponse.statusCode).toBe(200)
          expect(gateResponse.statusCode).toBe(200)
          expect(gateResponse.json<GateResponse>()).toEqual({ result: 'INVALID' })
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
    'serializes individual cancellation with a replacement hold and never exposes two active allocations',
    async () => {
      const session = await createTestSession()
      const purchase = await createPaidPurchase(session, [0, 1])
      const [firstTicket] = purchase.tickets as [TicketResponse, TicketResponse]
      const seatId = purchase.seatIds[0]!
      const connectionString = process.env.DATABASE_URL!
      const blocker = new Client({ connectionString })
      const observer = new Client({ connectionString })
      let blockerConnected = false
      let observerConnected = false
      let blockerTransactionOpen = false
      let cancellationRequest: ReturnType<typeof cancelTicket> | null = null
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

        cancellationRequest = cancelTicket(firstTicket.id)
        await waitForBlockedQueries(observer, 'cancel-ticket-lock-seat')
        replacementRequest = createHoldRequest(session.id, [seatId], 'SECOND_CUSTOMER')
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

  it('rolls back the ticket and its allocation when releasing the seat fails', async () => {
    const session = await createTestSession()
    const purchase = await createPaidPurchase(session, [0, 1])
    const [firstTicket, secondTicket] = purchase.tickets as [
      TicketResponse,
      TicketResponse,
    ]
    const allocation = await prisma.reservationSeat.findFirstOrThrow({
      where: { reservationId: purchase.reservationId, seatId: purchase.seatIds[0]! },
      select: { id: true },
    })
    await installFailureTrigger(allocation.id)

    try {
      const response = await cancelTicket(firstTicket.id)
      expect(response.statusCode).toBe(500)

      const [failureHit] = await prisma.$queryRawUnsafe<
        Array<{ value: number; isCalled: boolean }>
      >(
        `SELECT last_value::int AS "value", is_called AS "isCalled" FROM "${FAILURE_SEQUENCE}"`,
      )
      expect(failureHit).toEqual({ value: 1, isCalled: true })

      expect(
        await prisma.ticket.findUniqueOrThrow({
          where: { id: firstTicket.id },
          select: { status: true },
        }),
      ).toEqual({ status: TicketStatus.VALID })
      expect(
        await prisma.reservationSeat.count({
          where: { reservationId: purchase.reservationId, releasedAt: null },
        }),
      ).toBe(2)
      expect(
        await prisma.reservation.findUniqueOrThrow({
          where: { id: purchase.reservationId },
          select: { status: true },
        }),
      ).toEqual({ status: ReservationStatus.PAID })

      const ticketAfterRollback = await getTicket(firstTicket.id, Role.CUSTOMER)
      expect(ticketAfterRollback.json<TicketResponse>()).toMatchObject({
        status: TicketStatus.VALID,
        canCancel: true,
      })

      const secondTicketUnaffected = await getTicket(secondTicket.id, Role.CUSTOMER)
      expect(secondTicketUnaffected.json<TicketResponse>()).toMatchObject({
        status: TicketStatus.VALID,
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
      await removeFailureTrigger()
    }
  })
})
