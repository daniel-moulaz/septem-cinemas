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
import {
  generateManualCode,
  signTicketToken,
} from '../src/modules/tickets/ticket-crypto.js'

const TEST_SESSION_ADDRESS = 'Rua da Portaria, 500 — teste M5'
const TICKET_SIGNING_SECRET = process.env.TICKET_SIGNING_SECRET!

interface TestSession {
  id: string
  startsAt: Date
  movieRuntimeMinutes: number | null
  seats: Array<{ id: string; label: string }>
}

interface TicketFixture {
  id: string
  session: TestSession
  manualCode: string
  qrToken: string
}

interface GateSessionsResponse {
  sessions: Array<{
    id: string
    startsAt: string
    venueName: string
    roomName: string
    movie: { title: string; posterPath: string | null }
  }>
}

type ConsumeResponse =
  | { result: 'INVALID' | 'WRONG_EVENT' }
  | { result: 'ALREADY_USED'; usedAt: string }
  | {
      result: 'VALID'
      usedAt: string
      ticket: {
        seat: { label: string }
        session: {
          id: string
          movie: { title: string }
        }
      }
    }

const app = buildApp()
const accessTokens = new Map<Role, string>()
const createdSessionIds = new Set<string>()
let organizerId: string | null = null
let customerId: string | null = null
let gateId: string | null = null
let databaseSafetyConfirmed = false

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error('Os testes de portaria exigem NODE_ENV=test e DATABASE_URL local.')
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Os testes de portaria recusaram um PostgreSQL que não é local.')
  }

  databaseSafetyConfirmed = true
}

function requiredIds() {
  if (!organizerId || !customerId || !gateId) {
    throw new Error('Os usuários dos testes de portaria não foram inicializados.')
  }

  return { organizerId, customerId, gateId }
}

function tokenFor(role: Role) {
  const accessToken = accessTokens.get(role)

  if (!accessToken) {
    throw new Error(`Token de teste ausente para ${role}.`)
  }

  return accessToken
}

function authorization(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` }
}

function futureDate(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1_000)
}

async function createTestSession(
  options: {
    status?: SessionStatus
    hoursFromNow?: number
    movieTitle?: string
  } = {},
): Promise<TestSession> {
  const startsAt = futureDate(options.hoursFromNow ?? 24)
  const session = await prisma.session.create({
    data: {
      organizerId: requiredIds().organizerId,
      status: options.status ?? SessionStatus.PUBLISHED,
      startsAt,
      venueName: 'Cine Portaria',
      roomName: 'Sala Validação',
      address: TEST_SESSION_ADDRESS,
      priceCents: 3_200,
      tmdbMovieId: 505,
      movieTitle: options.movieTitle ?? 'A Última Sessão',
      movieOverview: 'Filme usado exclusivamente pelos testes do M5.',
      moviePosterPath: '/m5-poster.jpg',
      movieBackdropPath: null,
      movieReleaseDate: new Date('2026-01-01T00:00:00.000Z'),
      movieRuntimeMinutes: 100,
      publishedAt:
        options.status === SessionStatus.DRAFT ? null : new Date(),
      seats: {
        create: { rowLabel: 'B', number: 4, label: 'B4' },
      },
    },
    include: {
      seats: {
        select: { id: true, label: true },
      },
    },
  })

  createdSessionIds.add(session.id)

  return session
}

async function createTicketFixture(): Promise<TicketFixture> {
  const session = await createTestSession()
  const reservation = await prisma.reservation.create({
    data: {
      customerId: requiredIds().customerId,
      sessionId: session.id,
      status: ReservationStatus.PAID,
      expiresAt: futureDate(1),
      totalCents: 3_200,
      seats: {
        create: {
          seatId: session.seats[0]!.id,
          unitPriceCents: 3_200,
        },
      },
      payment: {
        create: {
          status: PaymentStatus.APPROVED,
          amountCents: 3_200,
        },
      },
    },
    include: { seats: true },
  })
  const issuedAt = new Date()
  const ticket = await prisma.ticket.create({
    data: {
      reservationSeatId: reservation.seats[0]!.id,
      sessionId: session.id,
      ownerId: requiredIds().customerId,
      status: TicketStatus.VALID,
      manualCode: generateManualCode(),
      issuedAt,
    },
  })

  return {
    id: ticket.id,
    session,
    manualCode: ticket.manualCode,
    qrToken: signTicketToken({
      ticketId: ticket.id,
      sessionId: session.id,
      issuedAt,
      sessionStartsAt: session.startsAt,
      movieRuntimeMinutes: session.movieRuntimeMinutes,
      secret: TICKET_SIGNING_SECRET,
    }),
  }
}

function consumeTicket(
  sessionId: string,
  credential: string,
  accessToken = tokenFor(Role.GATE),
  extraPayload: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/gate/tickets/consume',
    headers: authorization(accessToken),
    payload: { sessionId, credential, ...extraPayload },
  })
}

function tamperSignature(token: string) {
  const parts = token.split('.')
  const signature = parts[2]

  if (!signature) {
    throw new Error('Token de teste inválido.')
  }

  parts[2] = `${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`
  return parts.join('.')
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

async function waitForBlockedConsumeRequests(
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
        AND query LIKE '%gate-consume-ticket%'
    `)

    if ((result.rows[0]?.waiting_count ?? 0) >= expectedCount) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(
    `${expectedCount} validações não chegaram ao lock do ingresso.`,
  )
}

beforeAll(async () => {
  assertLocalTestDatabase()
  await app.ready()

  const [organizer, customer, gate] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: 'organizer@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'customer1@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'gate@demo.local' } }),
  ])

  organizerId = organizer.id
  customerId = customer.id
  gateId = gate.id
  accessTokens.set(
    Role.ORGANIZER,
    app.jwt.sign({ role: Role.ORGANIZER, sub: organizer.id }),
  )
  accessTokens.set(
    Role.CUSTOMER,
    app.jwt.sign({ role: Role.CUSTOMER, sub: customer.id }),
  )
  accessTokens.set(
    Role.GATE,
    app.jwt.sign({ role: Role.GATE, sub: gate.id }),
  )

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

describe('GET /gate/sessions', () => {
  it('lists only PUBLISHED sessions in start-time order with operational data', async () => {
    const later = await createTestSession({
      hoursFromNow: 30,
      movieTitle: 'Filme Tarde',
    })
    const draft = await createTestSession({
      status: SessionStatus.DRAFT,
      hoursFromNow: 12,
      movieTitle: 'Rascunho Invisível',
    })
    const earlier = await createTestSession({
      hoursFromNow: 20,
      movieTitle: 'Filme Cedo',
    })
    const response = await app.inject({
      method: 'GET',
      url: '/gate/sessions',
      headers: authorization(tokenFor(Role.GATE)),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<GateSessionsResponse>()
    const createdSessions = body.sessions.filter(({ id }) =>
      createdSessionIds.has(id),
    )

    expect(createdSessions.map(({ id }) => id)).toEqual([
      earlier.id,
      later.id,
    ])
    expect(createdSessions).not.toContainEqual(
      expect.objectContaining({ id: draft.id }),
    )
    expect(createdSessions[0]).toMatchObject({
      venueName: 'Cine Portaria',
      roomName: 'Sala Validação',
      movie: { title: 'Filme Cedo', posterPath: '/m5-poster.jpg' },
    })
    expect(JSON.stringify(createdSessions)).not.toMatch(/organizer|address/iu)
  })

  it('requires GATE authentication', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/gate/sessions',
    })

    expect(unauthenticated.statusCode).toBe(401)

    for (const role of [Role.CUSTOMER, Role.ORGANIZER]) {
      const forbidden = await app.inject({
        method: 'GET',
        url: '/gate/sessions',
        headers: authorization(tokenFor(role)),
      })
      expect(forbidden.statusCode).toBe(403)
    }
  })
})

describe('POST /gate/tickets/consume', () => {
  it('consumes a valid QR once with the database clock and authenticated gate', async () => {
    const fixture = await createTicketFixture()
    const first = await consumeTicket(fixture.session.id, fixture.qrToken)

    expect(first.statusCode).toBe(200)
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.json<ConsumeResponse>()).toMatchObject({
      result: 'VALID',
      usedAt: expect.any(String),
      ticket: {
        seat: { label: 'B4' },
        session: {
          id: fixture.session.id,
          movie: { title: 'A Última Sessão' },
        },
      },
    })

    const stored = await prisma.ticket.findUniqueOrThrow({
      where: { id: fixture.id },
    })
    expect(stored).toMatchObject({
      status: TicketStatus.USED,
      usedByGateId: requiredIds().gateId,
    })
    expect(stored.usedAt).not.toBeNull()
    expect(first.json<Extract<ConsumeResponse, { result: 'VALID' }>>().usedAt).toBe(
      stored.usedAt!.toISOString(),
    )

    const repeated = await consumeTicket(fixture.session.id, fixture.qrToken)
    expect(repeated.statusCode).toBe(200)
    expect(repeated.json<ConsumeResponse>()).toEqual({
      result: 'ALREADY_USED',
      usedAt: stored.usedAt!.toISOString(),
    })
  })

  it('returns WRONG_EVENT before usage state and never consumes in another session', async () => {
    const fixture = await createTicketFixture()
    const otherSession = await createTestSession({ movieTitle: 'Outro Filme' })
    const wrongEvent = await consumeTicket(otherSession.id, fixture.qrToken)

    expect(wrongEvent.statusCode).toBe(200)
    expect(wrongEvent.json<ConsumeResponse>()).toEqual({
      result: 'WRONG_EVENT',
    })
    expect(
      await prisma.ticket.findUniqueOrThrow({ where: { id: fixture.id } }),
    ).toMatchObject({
      status: TicketStatus.VALID,
      usedAt: null,
      usedByGateId: null,
    })

    expect(
      (await consumeTicket(fixture.session.id, fixture.qrToken)).json<ConsumeResponse>(),
    ).toMatchObject({ result: 'VALID' })
    const used = await prisma.ticket.findUniqueOrThrow({
      where: { id: fixture.id },
    })

    const wrongEventAfterUse = await consumeTicket(
      otherSession.id,
      fixture.qrToken,
    )
    expect(wrongEventAfterUse.json<ConsumeResponse>()).toEqual({
      result: 'WRONG_EVENT',
    })
    expect(
      await prisma.ticket.findUniqueOrThrow({ where: { id: fixture.id } }),
    ).toMatchObject({
      status: TicketStatus.USED,
      usedAt: used.usedAt,
      usedByGateId: used.usedByGateId,
    })
  })

  it('maps malformed, tampered, expired, and database-inconsistent QR tokens to INVALID', async () => {
    const fixture = await createTicketFixture()
    const expiredToken = signTicketToken({
      ticketId: fixture.id,
      sessionId: fixture.session.id,
      issuedAt: new Date('2020-01-01T00:00:00.000Z'),
      sessionStartsAt: new Date('2020-01-02T00:00:00.000Z'),
      movieRuntimeMinutes: 1,
      secret: TICKET_SIGNING_SECRET,
    })
    const mismatchedSessionToken = signTicketToken({
      ticketId: fixture.id,
      sessionId: '00000000-0000-4000-8000-000000000505',
      issuedAt: new Date(),
      sessionStartsAt: fixture.session.startsAt,
      movieRuntimeMinutes: fixture.session.movieRuntimeMinutes,
      secret: TICKET_SIGNING_SECRET,
    })

    for (const credential of [
      'token-malformado',
      tamperSignature(fixture.qrToken),
      expiredToken,
      mismatchedSessionToken,
    ]) {
      const response = await consumeTicket(fixture.session.id, credential)
      expect(response.statusCode).toBe(200)
      expect(response.json<ConsumeResponse>()).toEqual({ result: 'INVALID' })
      expect(response.body).not.toMatch(/assinatura|expirad|token/iu)
    }

    expect(
      await prisma.ticket.findUniqueOrThrow({ where: { id: fixture.id } }),
    ).toMatchObject({
      status: TicketStatus.VALID,
      usedAt: null,
      usedByGateId: null,
    })
  })

  it('normalizes a safely formatted manual code and rejects an unknown code', async () => {
    const fixture = await createTicketFixture()
    const typedCode = fixture.manualCode.toLowerCase().replaceAll('-', ' ')
    const consumed = await consumeTicket(fixture.session.id, typedCode)

    expect(consumed.statusCode).toBe(200)
    expect(consumed.json<ConsumeResponse>()).toMatchObject({ result: 'VALID' })

    const unknownCodes = [
      '2222-2222-2222-2222',
      '3333-3333-3333-3333',
    ]
    const existingCodes = await prisma.ticket.findMany({
      where: { manualCode: { in: unknownCodes } },
      select: { manualCode: true },
    })
    const unknownCode = unknownCodes.find(
      (code) => !existingCodes.some(({ manualCode }) => manualCode === code),
    )

    if (!unknownCode) {
      throw new Error('Os códigos manuais reservados pelo teste já existem.')
    }

    const invalid = await consumeTicket(fixture.session.id, unknownCode)
    expect(invalid.statusCode).toBe(200)
    expect(invalid.json<ConsumeResponse>()).toEqual({ result: 'INVALID' })
  })

  it('requires GATE and rejects client-controlled gate identity', async () => {
    const fixture = await createTicketFixture()
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/gate/tickets/consume',
      payload: {
        sessionId: fixture.session.id,
        credential: fixture.qrToken,
      },
    })
    expect(unauthenticated.statusCode).toBe(401)

    for (const role of [Role.CUSTOMER, Role.ORGANIZER]) {
      const forbidden = await consumeTicket(
        fixture.session.id,
        fixture.qrToken,
        tokenFor(role),
      )
      expect(forbidden.statusCode).toBe(403)
    }

    const injectedGate = await consumeTicket(
      fixture.session.id,
      fixture.qrToken,
      tokenFor(Role.GATE),
      { usedByGateId: requiredIds().customerId },
    )
    expect(injectedGate.statusCode).toBe(400)
    expect(
      await prisma.ticket.findUniqueOrThrow({ where: { id: fixture.id } }),
    ).toMatchObject({
      status: TicketStatus.VALID,
      usedAt: null,
      usedByGateId: null,
    })
  })
})

describe('concurrent gate consumption arbitration', () => {
  it(
    'returns exactly one VALID and one ALREADY_USED after both requests reach the same row lock',
    async () => {
      const fixture = await createTicketFixture()
      const connectionString = process.env.DATABASE_URL!
      const blocker = new Client({ connectionString })
      const observer = new Client({ connectionString })
      let blockerTransactionOpen = false
      const requests: Array<ReturnType<typeof consumeTicket>> = []

      await Promise.all([blocker.connect(), observer.connect()])

      try {
        await blocker.query('BEGIN')
        blockerTransactionOpen = true
        await blocker.query(
          'SELECT "id" FROM "Ticket" WHERE "id" = $1::uuid FOR UPDATE',
          [fixture.id],
        )

        requests.push(
          consumeTicket(fixture.session.id, fixture.qrToken),
          consumeTicket(fixture.session.id, fixture.qrToken),
        )

        await waitForBlockedConsumeRequests(observer)
        await blocker.query('COMMIT')
        blockerTransactionOpen = false

        const responses = await Promise.all(requests)
        const results = responses
          .map((response) => response.json<ConsumeResponse>().result)
          .sort()

        expect(responses.every(({ statusCode }) => statusCode === 200)).toBe(true)
        expect(results).toEqual(['ALREADY_USED', 'VALID'])

        const stored = await prisma.ticket.findUniqueOrThrow({
          where: { id: fixture.id },
        })
        expect(stored).toMatchObject({
          status: TicketStatus.USED,
          usedByGateId: requiredIds().gateId,
        })
        expect(stored.usedAt).not.toBeNull()

        const valid = responses.find(
          (response) => response.json<ConsumeResponse>().result === 'VALID',
        )
        const alreadyUsed = responses.find(
          (response) =>
            response.json<ConsumeResponse>().result === 'ALREADY_USED',
        )
        expect(valid?.json<Extract<ConsumeResponse, { result: 'VALID' }>>().usedAt).toBe(
          stored.usedAt!.toISOString(),
        )
        expect(
          alreadyUsed?.json<
            Extract<ConsumeResponse, { result: 'ALREADY_USED' }>
          >().usedAt,
        ).toBe(stored.usedAt!.toISOString())
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
