import { randomUUID } from 'node:crypto'
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
  ReservationStatus,
  Role,
  SessionStatus,
} from '../src/generated/prisma/enums.js'
import { prisma } from '../src/lib/prisma.js'

const TEST_SESSION_ADDRESS = 'Rua da Concorrência, 300 — teste M3'
const SESSION_PRICE_CENTS = 3_000

interface TestSeat {
  id: string
  label: string
}

interface TestSession {
  id: string
  seats: TestSeat[]
}

interface ReservationResponse {
  id: string
  status: ReservationStatus
  expiresAt: string
  totalCents: number
  session: {
    id: string
    movie: {
      title: string
      posterPath: string | null
    }
  }
  seats: Array<{
    id: string
    label: string
    unitPriceCents: number
  }>
}

const app = buildApp()
const accessTokens = new Map<Role | 'SECOND_CUSTOMER', string>()
const createdSessionIds = new Set<string>()
let databaseSafetyConfirmed = false
let organizerId: string | null = null
let customerOneId: string | null = null
let customerTwoId: string | null = null

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error('Os testes de reserva exigem NODE_ENV=test e DATABASE_URL local.')
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Os testes de reserva recusaram um PostgreSQL que não é local.')
  }

  databaseSafetyConfirmed = true
}

function requiredIds() {
  if (!organizerId || !customerOneId || !customerTwoId) {
    throw new Error('Os usuários de teste ainda não foram inicializados.')
  }

  return { organizerId, customerOneId, customerTwoId }
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

function futureDate(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1_000)
}

async function createTestSession(options: {
  status?: SessionStatus
  startsAt?: Date
  priceCents?: number
  seatCount?: number
} = {}): Promise<TestSession> {
  const status = options.status ?? SessionStatus.PUBLISHED
  const seatCount = options.seatCount ?? 8
  const { organizerId: ownerId } = requiredIds()
  const session = await prisma.session.create({
    data: {
      organizerId: ownerId,
      status,
      startsAt: options.startsAt ?? futureDate(),
      venueName: 'Cinema Concorrente',
      roomName: 'Sala Lock',
      address: TEST_SESSION_ADDRESS,
      priceCents: options.priceCents ?? SESSION_PRICE_CENTS,
      tmdbMovieId: 303,
      movieTitle: 'A Corrida pelo Assento',
      movieOverview: 'Sessão criada exclusivamente pelo teste M3.',
      moviePosterPath: '/m3-poster.jpg',
      movieBackdropPath: null,
      movieReleaseDate: new Date('2026-01-01T00:00:00.000Z'),
      movieRuntimeMinutes: 100,
      publishedAt:
        status === SessionStatus.PUBLISHED ? new Date() : null,
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

async function removeCreatedSessions() {
  if (!databaseSafetyConfirmed || createdSessionIds.size === 0) {
    return
  }

  const sessionIds = Array.from(createdSessionIds)

  await prisma.reservation.deleteMany({
    where: { sessionId: { in: sessionIds } },
  })
  await prisma.session.deleteMany({ where: { id: { in: sessionIds } } })
  createdSessionIds.clear()
}

function createHold(
  sessionId: string,
  seatIds: string[],
  accessToken = tokenFor(Role.CUSTOMER),
) {
  return app.inject({
    method: 'POST',
    url: '/reservations',
    headers: authorization(accessToken),
    payload: { sessionId, seatIds },
  })
}

async function createSuccessfulHold(
  sessionId: string,
  seatIds: string[],
  accessToken = tokenFor(Role.CUSTOMER),
) {
  const response = await createHold(sessionId, seatIds, accessToken)

  expect(response.statusCode).toBe(201)

  return response.json<ReservationResponse>()
}

async function waitForBlockedSeatRequests(observer: Client) {
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

    if ((result.rows[0]?.waiting_count ?? 0) >= 2) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error('As duas requisições não chegaram juntas ao lock do assento.')
}

beforeAll(async () => {
  assertLocalTestDatabase()
  await app.ready()

  const [organizer, customerOne, customerTwo, gate] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { email: 'organizer@demo.local' },
    }),
    prisma.user.findUniqueOrThrow({
      where: { email: 'customer1@demo.local' },
    }),
    prisma.user.findUniqueOrThrow({
      where: { email: 'customer2@demo.local' },
    }),
    prisma.user.findUniqueOrThrow({ where: { email: 'gate@demo.local' } }),
  ])

  organizerId = organizer.id
  customerOneId = customerOne.id
  customerTwoId = customerTwo.id

  await prisma.reservation.deleteMany({
    where: { session: { address: TEST_SESSION_ADDRESS } },
  })
  await prisma.session.deleteMany({
    where: {
      organizerId: organizer.id,
      address: TEST_SESSION_ADDRESS,
    },
  })

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
})

beforeEach(async () => {
  await removeCreatedSessions()
})

afterAll(async () => {
  try {
    await removeCreatedSessions()
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
})

describe('POST /reservations authorization and validation', () => {
  it('requires authentication', async () => {
    const session = await createTestSession()
    const response = await app.inject({
      method: 'POST',
      url: '/reservations',
      payload: { sessionId: session.id, seatIds: [session.seats[0]?.id] },
    })

    expect(response.statusCode).toBe(401)
  })

  it.each([Role.ORGANIZER, Role.GATE])('rejects the %s role', async (role) => {
    const session = await createTestSession()
    const response = await createHold(
      session.id,
      [session.seats[0]!.id],
      tokenFor(role),
    )

    expect(response.statusCode).toBe(403)
    expect(await prisma.reservation.count({ where: { sessionId: session.id } })).toBe(0)
  })

  it('rejects client-controlled authority fields', async () => {
    const session = await createTestSession()
    const response = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: authorization(tokenFor(Role.CUSTOMER)),
      payload: {
        sessionId: session.id,
        seatIds: [session.seats[0]!.id],
        customerId: requiredIds().customerTwoId,
        totalCents: 1,
        expiresAt: futureDate(100).toISOString(),
      },
    })

    expect(response.statusCode).toBe(400)
    expect(await prisma.reservation.count({ where: { sessionId: session.id } })).toBe(0)
  })

  it('rejects a missing, draft, or past session', async () => {
    const draft = await createTestSession({ status: SessionStatus.DRAFT })
    const past = await createTestSession({ startsAt: futureDate(-1) })

    const responses = await Promise.all([
      createHold(randomUUID(), [randomUUID()]),
      createHold(draft.id, [draft.seats[0]!.id]),
      createHold(past.id, [past.seats[0]!.id]),
    ])

    for (const response of responses) {
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({
        error: 'SESSION_NOT_AVAILABLE',
      })
    }
  })

  it('rejects unknown seats, seats from another session, duplicates, and more than six seats', async () => {
    const session = await createTestSession()
    const otherSession = await createTestSession()
    const invalidSeatSets = [
      [],
      [randomUUID()],
      [otherSession.seats[0]!.id],
      [session.seats[0]!.id, session.seats[0]!.id],
      session.seats.slice(0, 7).map(({ id }) => id),
    ]

    for (const seatIds of invalidSeatSets) {
      const response = await createHold(session.id, seatIds)
      expect(response.statusCode).toBe(400)
    }

    expect(await prisma.reservation.count({ where: { sessionId: session.id } })).toBe(0)
  })
})

describe('reservation hold lifecycle', () => {
  it('creates a ten-minute hold with trusted customer and prices', async () => {
    const session = await createTestSession({ priceCents: 4_250 })
    const beforeRequest = Date.now()
    const hold = await createSuccessfulHold(
      session.id,
      session.seats.slice(0, 2).map(({ id }) => id),
    )
    const afterRequest = Date.now()

    expect(hold).toMatchObject({
      status: ReservationStatus.PENDING,
      totalCents: 8_500,
      session: {
        id: session.id,
        movie: {
          title: 'A Corrida pelo Assento',
          posterPath: '/m3-poster.jpg',
        },
      },
    })
    expect(hold.seats).toHaveLength(2)
    expect(hold.seats.every(({ unitPriceCents }) => unitPriceCents === 4_250)).toBe(true)
    expect(new Date(hold.expiresAt).getTime()).toBeGreaterThanOrEqual(
      beforeRequest + 10 * 60 * 1_000,
    )
    expect(new Date(hold.expiresAt).getTime()).toBeLessThanOrEqual(
      afterRequest + 10 * 60 * 1_000 + 1_000,
    )

    const stored = await prisma.reservation.findUniqueOrThrow({
      where: { id: hold.id },
      include: { seats: true },
    })
    expect(stored.customerId).toBe(requiredIds().customerOneId)
    expect(stored.totalCents).toBe(8_500)
    expect(stored.seats.map(({ unitPriceCents }) => unitPriceCents)).toEqual([
      4_250,
      4_250,
    ])
  })

  it('allows only the owner to read and normalizes an expired hold', async () => {
    const session = await createTestSession()
    const hold = await createSuccessfulHold(session.id, [session.seats[0]!.id])

    const otherCustomerResponse = await app.inject({
      method: 'GET',
      url: `/reservations/${hold.id}`,
      headers: authorization(tokenFor('SECOND_CUSTOMER')),
    })
    expect(otherCustomerResponse.statusCode).toBe(404)
    expect(otherCustomerResponse.json()).toMatchObject({
      error: 'RESERVATION_NOT_FOUND',
    })

    await prisma.reservation.update({
      where: { id: hold.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })

    const ownerResponse = await app.inject({
      method: 'GET',
      url: `/reservations/${hold.id}`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })

    expect(ownerResponse.statusCode).toBe(200)
    expect(ownerResponse.json<ReservationResponse>()).toMatchObject({
      id: hold.id,
      status: ReservationStatus.EXPIRED,
      seats: [],
    })
    const releasedAllocations = await prisma.reservationSeat.findMany({
      where: { reservationId: hold.id },
      select: { releasedAt: true },
    })

    expect(releasedAllocations).toEqual([
      { releasedAt: expect.any(Date) },
    ])
    expect(
      await prisma.reservationSeat.count({
        where: { reservationId: hold.id, releasedAt: null },
      }),
    ).toBe(0)
  })

  it('releases an expired hold atomically and lets another customer reserve the seat', async () => {
    const session = await createTestSession()
    const seatId = session.seats[0]!.id
    const expiredHold = await createSuccessfulHold(session.id, [seatId])

    await prisma.$executeRaw`
      UPDATE "Reservation"
      SET "expiresAt" = clock_timestamp()
      WHERE "id" = ${expiredHold.id}::uuid
    `

    const replacement = await createHold(
      session.id,
      [seatId],
      tokenFor('SECOND_CUSTOMER'),
    )

    expect(replacement.statusCode).toBe(201)
    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: expiredHold.id },
        select: { status: true },
      }),
    ).toEqual({ status: ReservationStatus.EXPIRED })
    const replacementId = replacement.json<ReservationResponse>().id
    const allocations = await prisma.reservationSeat.findMany({
      where: { seatId },
      select: { reservationId: true, releasedAt: true },
    })

    expect(allocations).toHaveLength(2)
    expect(allocations).toEqual(
      expect.arrayContaining([
        {
          reservationId: expiredHold.id,
          releasedAt: expect.any(Date),
        },
        { reservationId: replacementId, releasedAt: null },
      ]),
    )
  })

  it('returns 409 for an active hold without creating an orphan reservation', async () => {
    const session = await createTestSession()
    const seatId = session.seats[0]!.id
    await createSuccessfulHold(session.id, [seatId])

    const response = await createHold(
      session.id,
      [seatId],
      tokenFor('SECOND_CUSTOMER'),
    )

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: 'SEAT_UNAVAILABLE',
      message: 'Um ou mais assentos não estão mais disponíveis.',
    })
    expect(await prisma.reservation.count({ where: { sessionId: session.id } })).toBe(1)
    expect(await prisma.reservationSeat.count({ where: { seatId } })).toBe(1)
  })

  it('keeps a multi-seat request all-or-nothing when one seat is unavailable', async () => {
    const session = await createTestSession()
    const [seatA7, seatA8] = session.seats.slice(6, 8)
    await createSuccessfulHold(session.id, [seatA8!.id])

    const response = await createHold(
      session.id,
      [seatA7!.id, seatA8!.id],
      tokenFor('SECOND_CUSTOMER'),
    )

    expect(response.statusCode).toBe(409)
    expect(await prisma.reservationSeat.count({ where: { seatId: seatA7!.id } })).toBe(0)
    expect(
      await prisma.reservation.count({
        where: {
          sessionId: session.id,
          customerId: requiredIds().customerTwoId,
        },
      }),
    ).toBe(0)
  })

  it('keeps one active allocation per seat as the database-level final defense', async () => {
    const session = await createTestSession()
    const seatId = session.seats[0]!.id
    await createSuccessfulHold(session.id, [seatId])

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

    expect(await prisma.reservation.count({ where: { sessionId: session.id } })).toBe(1)
    expect(await prisma.reservationSeat.count({ where: { seatId } })).toBe(1)
  })
})

describe('concurrent reservation arbitration', () => {
  it(
    'lets exactly one customer win A7 while the other receives 409',
    async () => {
      const session = await createTestSession()
      const seatA7 = session.seats.find(({ label }) => label === 'A7')!
      const connectionString = process.env.DATABASE_URL!
      const blocker = new Client({ connectionString })
      const observer = new Client({ connectionString })
      let blockerTransactionOpen = false
      const requests: Array<ReturnType<typeof createHold>> = []

      await Promise.all([blocker.connect(), observer.connect()])

      try {
        await blocker.query('BEGIN')
        blockerTransactionOpen = true
        await blocker.query(
          'SELECT "id" FROM "Seat" WHERE "id" = $1::uuid FOR UPDATE',
          [seatA7.id],
        )

        requests.push(
          createHold(session.id, [seatA7.id], tokenFor(Role.CUSTOMER)),
          createHold(session.id, [seatA7.id], tokenFor('SECOND_CUSTOMER')),
        )

        await waitForBlockedSeatRequests(observer)
        await blocker.query('COMMIT')
        blockerTransactionOpen = false

        const responses = await Promise.all(requests)
        expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([
          201,
          409,
        ])
        expect(responses.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({
          error: 'SEAT_UNAVAILABLE',
        })
        expect(await prisma.reservationSeat.count({ where: { seatId: seatA7.id } })).toBe(1)
        expect(await prisma.reservation.count({ where: { sessionId: session.id } })).toBe(1)
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
