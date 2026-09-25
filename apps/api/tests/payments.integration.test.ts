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

const TEST_SESSION_ADDRESS = 'Rua da Atomicidade, 400 — teste M4'
const SESSION_PRICE_CENTS = 3_750
const PAYMENT_FAILURE_TRIGGER = 'M4_fail_selected_ticket'
const PAYMENT_FAILURE_FUNCTION = 'M4_fail_selected_ticket_function'
const PAYMENT_FAILURE_TABLE = 'M4TicketFailure'

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

const app = buildApp()
const accessTokens = new Map<Role | 'SECOND_CUSTOMER', string>()
const createdSessionIds = new Set<string>()
let databaseSafetyConfirmed = false
let organizerId: string | null = null

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error('Os testes de pagamento exigem NODE_ENV=test e DATABASE_URL local.')
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Os testes de pagamento recusaram um PostgreSQL que não é local.')
  }

  databaseSafetyConfirmed = true
}

function requiredOrganizerId() {
  if (!organizerId) {
    throw new Error('O organizador de teste ainda não foi inicializado.')
  }

  return organizerId
}

function authorization(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` }
}

function tokenFor(role: Role | 'SECOND_CUSTOMER') {
  const accessToken = accessTokens.get(role)

  if (!accessToken) {
    throw new Error(`Token de teste ausente para ${role}.`)
  }

  return accessToken
}

async function createTestSession(seatCount = 4): Promise<TestSession> {
  const session = await prisma.session.create({
    data: {
      organizerId: requiredOrganizerId(),
      status: SessionStatus.PUBLISHED,
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      venueName: 'Cinema Transacional',
      roomName: 'Sala Commit',
      address: TEST_SESSION_ADDRESS,
      priceCents: SESSION_PRICE_CENTS,
      tmdbMovieId: 404,
      movieTitle: 'Tudo ou Nada',
      movieOverview: 'Sessão criada exclusivamente pelo teste M4.',
      moviePosterPath: '/m4-poster.jpg',
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

async function createHold(
  session: TestSession,
  seatIndexes = [0],
  accessToken = tokenFor(Role.CUSTOMER),
) {
  const response = await app.inject({
    method: 'POST',
    url: '/reservations',
    headers: authorization(accessToken),
    payload: {
      sessionId: session.id,
      seatIds: seatIndexes.map((index) => session.seats[index]!.id),
    },
  })

  expect(response.statusCode).toBe(201)

  return response.json<HoldResponse>()
}

function payReservation(
  reservationId: string,
  outcome: 'APPROVED' | 'DECLINED',
  accessToken = tokenFor(Role.CUSTOMER),
) {
  return app.inject({
    method: 'POST',
    url: `/reservations/${reservationId}/payment`,
    headers: authorization(accessToken),
    payload: { outcome },
  })
}

async function removePaymentFailureTrigger() {
  if (!databaseSafetyConfirmed) {
    return
  }

  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS "${PAYMENT_FAILURE_TRIGGER}" ON "Ticket"`,
  )
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS "${PAYMENT_FAILURE_FUNCTION}"()`,
  )
  await prisma.$executeRawUnsafe(
    `DROP TABLE IF EXISTS "${PAYMENT_FAILURE_TABLE}"`,
  )
}

async function installPaymentFailureTrigger(reservationSeatId: string) {
  if (!databaseSafetyConfirmed) {
    throw new Error('O banco local de teste não foi confirmado.')
  }

  await removePaymentFailureTrigger()
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${PAYMENT_FAILURE_TABLE}" (
      "reservationSeatId" UUID PRIMARY KEY
    )
  `)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${PAYMENT_FAILURE_TABLE}" ("reservationSeatId") VALUES ($1::uuid)`,
    reservationSeatId,
  )
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${PAYMENT_FAILURE_FUNCTION}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM "${PAYMENT_FAILURE_TABLE}"
        WHERE "reservationSeatId" = NEW."reservationSeatId"
      ) THEN
        RAISE EXCEPTION 'controlled M4 ticket emission failure';
      END IF;

      RETURN NEW;
    END;
    $function$
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${PAYMENT_FAILURE_TRIGGER}"
    BEFORE INSERT ON "Ticket"
    FOR EACH ROW
    EXECUTE FUNCTION "${PAYMENT_FAILURE_FUNCTION}"()
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

async function waitForBlockedPaymentRequests(
  observer: Client,
  expectedCount = 2,
) {
  const deadline = Date.now() + 5_000

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
    `${expectedCount} pagamento(s) não chegaram ao lock do assento.`,
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

  await removePaymentFailureTrigger()
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
  await removePaymentFailureTrigger()
  await removeCreatedSessions()
})

afterAll(async () => {
  try {
    await removePaymentFailureTrigger()
    await removeCreatedSessions()
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
})

describe('POST /reservations/:id/payment authorization', () => {
  it('hides a reservation from another customer', async () => {
    const session = await createTestSession()
    const hold = await createHold(session)
    const response = await payReservation(
      hold.id,
      'APPROVED',
      tokenFor('SECOND_CUSTOMER'),
    )

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: 'RESERVATION_NOT_FOUND' })
    expect(await prisma.payment.count({ where: { reservationId: hold.id } })).toBe(0)
  })

  it.each([Role.ORGANIZER, Role.GATE])('rejects the %s role', async (role) => {
    const session = await createTestSession()
    const hold = await createHold(session)
    const response = await payReservation(hold.id, 'APPROVED', tokenFor(role))

    expect(response.statusCode).toBe(403)
    expect(await prisma.payment.count({ where: { reservationId: hold.id } })).toBe(0)
  })

  it('requires authentication and rejects client-controlled amount', async () => {
    const session = await createTestSession()
    const hold = await createHold(session)
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/reservations/${hold.id}/payment`,
      payload: { outcome: 'APPROVED' },
    })
    const withAmount = await app.inject({
      method: 'POST',
      url: `/reservations/${hold.id}/payment`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
      payload: { outcome: 'APPROVED', amountCents: 1 },
    })

    expect(unauthenticated.statusCode).toBe(401)
    expect(withAmount.statusCode).toBe(400)
    expect(await prisma.payment.count({ where: { reservationId: hold.id } })).toBe(0)
  })
})

describe('payment state transitions', () => {
  it('approves atomically, trusts the reservation amount, and emits one ticket per seat', async () => {
    const session = await createTestSession()
    const hold = await createHold(session, [0, 1])
    const response = await payReservation(hold.id, 'APPROVED')

    expect(response.statusCode).toBe(200)
    expect(response.json<PaymentResponse>()).toMatchObject({
      payment: {
        status: PaymentStatus.APPROVED,
        amountCents: SESSION_PRICE_CENTS * 2,
      },
      reservation: {
        id: hold.id,
        status: ReservationStatus.PAID,
      },
    })
    expect(response.json<PaymentResponse>().tickets).toHaveLength(2)

    const storedReservation = await prisma.reservation.findUniqueOrThrow({
      where: { id: hold.id },
      include: { payment: true, seats: { include: { ticket: true } } },
    })

    expect(storedReservation.status).toBe(ReservationStatus.PAID)
    expect(storedReservation.payment).toMatchObject({
      status: PaymentStatus.APPROVED,
      amountCents: SESSION_PRICE_CENTS * 2,
    })
    expect(storedReservation.seats).toHaveLength(2)
    expect(storedReservation.seats.every(({ ticket }) => ticket?.status === TicketStatus.VALID)).toBe(true)
    expect(storedReservation.seats.map(({ ticket }) => ticket!.manualCode)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/u),
        expect.stringMatching(/^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/u),
      ]),
    )
    expect(new Set(storedReservation.seats.map(({ ticket }) => ticket!.manualCode)).size).toBe(2)
  })

  it('declines atomically, creates no ticket, and releases every seat', async () => {
    const session = await createTestSession()
    const hold = await createHold(session, [0, 1])
    const response = await payReservation(hold.id, 'DECLINED')

    expect(response.statusCode).toBe(200)
    expect(response.json<PaymentResponse>()).toMatchObject({
      payment: {
        status: PaymentStatus.DECLINED,
        amountCents: SESSION_PRICE_CENTS * 2,
      },
      reservation: { status: ReservationStatus.CANCELLED },
      tickets: [],
    })
    const releasedAllocations = await prisma.reservationSeat.findMany({
      where: { reservationId: hold.id },
      select: { releasedAt: true },
    })
    expect(releasedAllocations).toHaveLength(2)
    expect(
      releasedAllocations.every(({ releasedAt }) => releasedAt !== null),
    ).toBe(true)
    expect(
      await prisma.reservationSeat.count({
        where: { reservationId: hold.id, releasedAt: null },
      }),
    ).toBe(0)
    expect(await prisma.ticket.count({ where: { sessionId: session.id } })).toBe(0)

    const replacement = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: authorization(tokenFor('SECOND_CUSTOMER')),
      payload: {
        sessionId: session.id,
        seatIds: [session.seats[0]!.id, session.seats[1]!.id],
      },
    })
    expect(replacement.statusCode).toBe(201)
  })

  it('expires and releases an elapsed hold without creating a payment', async () => {
    const session = await createTestSession()
    const hold = await createHold(session)

    await prisma.$executeRaw`
      UPDATE "Reservation"
      SET "expiresAt" = clock_timestamp()
      WHERE "id" = ${hold.id}::uuid
    `

    const response = await payReservation(hold.id, 'APPROVED')

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'RESERVATION_EXPIRED' })
    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: hold.id },
        select: { status: true },
      }),
    ).toEqual({ status: ReservationStatus.EXPIRED })
    expect(
      await prisma.reservationSeat.findMany({
        where: { reservationId: hold.id },
        select: { releasedAt: true },
      }),
    ).toEqual([{ releasedAt: expect.any(Date) }])
    expect(
      await prisma.reservationSeat.count({
        where: { reservationId: hold.id, releasedAt: null },
      }),
    ).toBe(0)
    expect(await prisma.payment.count({ where: { reservationId: hold.id } })).toBe(0)
  })

  it('returns a stable conflict on repeated payment without duplicating records', async () => {
    const session = await createTestSession()
    const hold = await createHold(session, [0, 1])

    expect((await payReservation(hold.id, 'APPROVED')).statusCode).toBe(200)
    const repeated = await payReservation(hold.id, 'APPROVED')

    expect(repeated.statusCode).toBe(409)
    expect(repeated.json()).toMatchObject({ error: 'PAYMENT_ALREADY_PROCESSED' })
    expect(await prisma.payment.count({ where: { reservationId: hold.id } })).toBe(1)
    expect(await prisma.ticket.count({ where: { sessionId: session.id } })).toBe(2)
  })

  it('rolls back Payment, PAID, and every Ticket when the second ticket insert fails', async () => {
    const session = await createTestSession()
    const hold = await createHold(session, [0, 1])
    const reservationSeats = await prisma.reservationSeat.findMany({
      where: { reservationId: hold.id },
      select: { id: true, seatId: true },
      orderBy: { seatId: 'asc' },
    })

    await installPaymentFailureTrigger(reservationSeats[1]!.id)

    try {
      const response = await payReservation(hold.id, 'APPROVED')

      expect(response.statusCode).toBe(500)
      expect(await prisma.payment.count({ where: { reservationId: hold.id } })).toBe(0)
      expect(await prisma.ticket.count({ where: { sessionId: session.id } })).toBe(0)
      expect(await prisma.reservationSeat.count({ where: { reservationId: hold.id } })).toBe(2)
      expect(
        await prisma.reservation.findUniqueOrThrow({
          where: { id: hold.id },
          select: { status: true },
        }),
      ).toEqual({ status: ReservationStatus.PENDING })
    } finally {
      await removePaymentFailureTrigger()
    }
  })
})

describe('concurrent payment arbitration', () => {
  it(
    'allows one of two simultaneous approvals and emits tickets only once',
    async () => {
      const session = await createTestSession()
      const hold = await createHold(session, [0, 1])
      const sortedSeatIds = session.seats
        .slice(0, 2)
        .map(({ id }) => id)
        .sort((left, right) => left.localeCompare(right))
      const connectionString = process.env.DATABASE_URL!
      const blocker = new Client({ connectionString })
      const observer = new Client({ connectionString })
      let blockerTransactionOpen = false
      const requests: Array<ReturnType<typeof payReservation>> = []

      await Promise.all([blocker.connect(), observer.connect()])

      try {
        await blocker.query('BEGIN')
        blockerTransactionOpen = true
        await blocker.query(
          'SELECT "id" FROM "Seat" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" ASC FOR UPDATE',
          [sortedSeatIds],
        )

        requests.push(
          payReservation(hold.id, 'APPROVED'),
          payReservation(hold.id, 'APPROVED'),
        )

        await waitForBlockedPaymentRequests(observer)
        await blocker.query('COMMIT')
        blockerTransactionOpen = false

        const responses = await Promise.all(requests)

        expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([
          200,
          409,
        ])
        expect(responses.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({
          error: 'PAYMENT_ALREADY_PROCESSED',
        })
        expect(await prisma.payment.count({ where: { reservationId: hold.id } })).toBe(1)
        expect(await prisma.ticket.count({ where: { sessionId: session.id } })).toBe(2)
        expect(
          await prisma.reservation.findUniqueOrThrow({
            where: { id: hold.id },
            select: { status: true },
          }),
        ).toEqual({ status: ReservationStatus.PAID })
      } finally {
        if (blockerTransactionOpen) {
          await blocker.query('ROLLBACK')
        }

        await Promise.allSettled(requests)
        await Promise.all([blocker.end(), observer.end()])
      }
    },
    15_000,
  )

  it.each([
    {
      description: 'APPROVED wins over DECLINED',
      winningOutcome: 'APPROVED' as const,
      losingOutcome: 'DECLINED' as const,
      finalReservationStatus: ReservationStatus.PAID,
      finalPaymentStatus: PaymentStatus.APPROVED,
      expectedTickets: 2,
      expectedReservationSeats: 2,
      expectedActiveReservationSeats: 2,
    },
    {
      description: 'DECLINED wins over APPROVED',
      winningOutcome: 'DECLINED' as const,
      losingOutcome: 'APPROVED' as const,
      finalReservationStatus: ReservationStatus.CANCELLED,
      finalPaymentStatus: PaymentStatus.DECLINED,
      expectedTickets: 0,
      expectedReservationSeats: 2,
      expectedActiveReservationSeats: 0,
    },
  ])(
    '$description when both outcomes contend for the same reservation',
    async ({
      winningOutcome,
      losingOutcome,
      finalReservationStatus,
      finalPaymentStatus,
      expectedTickets,
      expectedReservationSeats,
      expectedActiveReservationSeats,
    }) => {
      const session = await createTestSession()
      const hold = await createHold(session, [0, 1])
      const sortedSeatIds = session.seats
        .slice(0, 2)
        .map(({ id }) => id)
        .sort((left, right) => left.localeCompare(right))
      const connectionString = process.env.DATABASE_URL!
      const blocker = new Client({ connectionString })
      const observer = new Client({ connectionString })
      let blockerTransactionOpen = false
      const requests: Array<ReturnType<typeof payReservation>> = []

      await Promise.all([blocker.connect(), observer.connect()])

      try {
        await blocker.query('BEGIN')
        blockerTransactionOpen = true
        await blocker.query(
          'SELECT "id" FROM "Seat" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" ASC FOR UPDATE',
          [sortedSeatIds],
        )

        const winnerRequest = payReservation(hold.id, winningOutcome)
        requests.push(winnerRequest)
        await waitForBlockedPaymentRequests(observer, 1)

        const loserRequest = payReservation(hold.id, losingOutcome)
        requests.push(loserRequest)
        await waitForBlockedPaymentRequests(observer, 2)

        await blocker.query('COMMIT')
        blockerTransactionOpen = false

        const [winnerResponse, loserResponse] = await Promise.all([
          winnerRequest,
          loserRequest,
        ])

        expect(winnerResponse.statusCode).toBe(200)
        expect(loserResponse.statusCode).toBe(409)
        expect(loserResponse.json()).toMatchObject({
          error: 'PAYMENT_ALREADY_PROCESSED',
        })

        const storedReservation =
          await prisma.reservation.findUniqueOrThrow({
            where: { id: hold.id },
            include: { payment: true },
          })

        expect(storedReservation.status).toBe(finalReservationStatus)
        expect(storedReservation.payment?.status).toBe(finalPaymentStatus)
        expect(
          await prisma.payment.count({ where: { reservationId: hold.id } }),
        ).toBe(1)
        expect(
          await prisma.ticket.count({ where: { sessionId: session.id } }),
        ).toBe(expectedTickets)
        expect(
          await prisma.reservationSeat.count({
            where: { reservationId: hold.id },
          }),
        ).toBe(expectedReservationSeats)
        expect(
          await prisma.reservationSeat.count({
            where: { reservationId: hold.id, releasedAt: null },
          }),
        ).toBe(expectedActiveReservationSeats)
      } finally {
        if (blockerTransactionOpen) {
          await blocker.query('ROLLBACK')
        }

        await Promise.allSettled(requests)
        await Promise.all([blocker.end(), observer.end()])
      }
    },
    15_000,
  )
})
