import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import {
  PaymentStatus,
  Role,
  SessionStatus,
} from '../src/generated/prisma/enums.js'
import { HttpError } from '../src/http/error-response.js'
import { prisma } from '../src/lib/prisma.js'
import type {
  CatalogMovie,
  CatalogMovieDetails,
  MovieCatalog,
} from '../src/modules/catalog/catalog.types.js'

const TEST_SESSION_ADDRESS = 'Rua da Cópia, 505 — teste P1.3'
const SESSION_PRICE_CENTS = 4_400
const FAILURE_TRIGGER = 'P13_fail_seat_copy'
const FAILURE_FUNCTION = 'P13_fail_seat_copy_function'
const FAILURE_TABLE = 'P13DuplicateFailure'

const movie: CatalogMovieDetails = {
  id: 701,
  title: 'Sessão Original',
  overview: 'Snapshot da suíte P1.3.',
  posterPath: '/poster-701.jpg',
  backdropPath: '/backdrop-701.jpg',
  releaseDate: '2026-05-20',
  runtimeMinutes: 118,
}

class FakeMovieCatalog implements MovieCatalog {
  readonly detailCalls: number[] = []

  async listNowPlaying(): Promise<CatalogMovie[]> {
    return [movie]
  }

  async searchMovies(): Promise<CatalogMovie[]> {
    return [movie]
  }

  async getMovieDetails(tmdbMovieId: number) {
    this.detailCalls.push(tmdbMovieId)

    if (tmdbMovieId === movie.id) {
      return movie
    }

    throw new HttpError(404, 'MOVIE_NOT_FOUND', 'Filme não encontrado.')
  }

  reset() {
    this.detailCalls.length = 0
  }
}

interface SessionResponse {
  id: string
  status: SessionStatus
  startsAt: string
  venueName: string
  roomName: string
  address: string
  priceCents: number
  publishedAt: string | null
  capacity: number
  rows: number
  seatsPerRow: number
  movie: {
    tmdbId: number
    title: string
    overview: string
    posterPath: string | null
    backdropPath: string | null
    releaseDate: string | null
    runtimeMinutes: number | null
  }
  editability: { allowed: boolean; reason: string; layoutEditable: boolean }
  metrics: { capacity: number; soldSeats: number; simulatedRevenueCents: number }
}

type AuthIdentity = Role | 'SECOND_ORGANIZER'

const movieCatalog = new FakeMovieCatalog()
const app = buildApp({}, { movieCatalog })
const accessTokens = new Map<AuthIdentity, string>()
const createdSessionIds = new Set<string>()
let databaseSafetyConfirmed = false
let secondOrganizerId: string | null = null

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error('Os testes de duplicação exigem NODE_ENV=test e DATABASE_URL local.')
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Os testes de duplicação recusaram um PostgreSQL não local.')
  }

  databaseSafetyConfirmed = true
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

async function createSession(options: { publish?: boolean } = {}) {
  const created = await app.inject({
    method: 'POST',
    url: '/organizer/sessions',
    headers: authorization(tokenFor(Role.ORGANIZER)),
    payload: {
      tmdbMovieId: movie.id,
      startsAt: new Date(Date.now() + 72 * 60 * 60 * 1_000).toISOString(),
      venueName: 'Cine Original',
      roomName: 'Sala Matriz',
      address: TEST_SESSION_ADDRESS,
      priceCents: SESSION_PRICE_CENTS,
      rows: 2,
      seatsPerRow: 3,
    },
  })
  expect(created.statusCode).toBe(201)
  const session = created.json<SessionResponse>()
  createdSessionIds.add(session.id)

  if (!options.publish) {
    return session
  }

  const published = await app.inject({
    method: 'POST',
    url: `/organizer/sessions/${session.id}/publish`,
    headers: authorization(tokenFor(Role.ORGANIZER)),
  })
  expect(published.statusCode).toBe(200)

  return published.json<SessionResponse>()
}

function duplicateSession(
  sessionId: string,
  identity: AuthIdentity = Role.ORGANIZER,
) {
  return app.inject({
    method: 'POST',
    url: `/organizer/sessions/${sessionId}/duplicate`,
    headers: authorization(tokenFor(identity)),
  })
}

async function removeFailureTrigger() {
  if (!databaseSafetyConfirmed) {
    return
  }

  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS "${FAILURE_TRIGGER}" ON "Seat"`,
  )
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${FAILURE_FUNCTION}"()`)
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${FAILURE_TABLE}"`)
}

async function installSeatCopyFailureTrigger() {
  await removeFailureTrigger()
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${FAILURE_TABLE}" ("marker" TEXT PRIMARY KEY)
  `)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${FAILURE_TABLE}" ("marker") VALUES ('active')`,
  )
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${FAILURE_FUNCTION}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF EXISTS (SELECT 1 FROM "${FAILURE_TABLE}" WHERE "marker" = 'active') THEN
        RAISE EXCEPTION 'controlled P1.3 seat copy failure';
      END IF;

      RETURN NEW;
    END;
    $function$
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${FAILURE_TRIGGER}"
    BEFORE INSERT ON "Seat"
    FOR EACH ROW
    EXECUTE FUNCTION "${FAILURE_FUNCTION}"()
  `)
}

async function removeCreatedSessions() {
  if (!databaseSafetyConfirmed) {
    return
  }

  const sessions = await prisma.session.findMany({
    where: { address: TEST_SESSION_ADDRESS },
    select: { id: true },
  })
  const sessionIds = [
    ...new Set([...createdSessionIds, ...sessions.map(({ id }) => id)]),
  ]

  if (sessionIds.length === 0) {
    return
  }

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

beforeAll(async () => {
  assertLocalTestDatabase()
  await app.ready()

  const [organizer, customer, gate] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: 'organizer@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'customer1@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'gate@demo.local' } }),
  ])
  const secondOrganizer = await prisma.user.upsert({
    where: { email: 'organizer-p13@demo.local' },
    update: {},
    create: {
      email: 'organizer-p13@demo.local',
      name: 'Organizador P1.3',
      passwordHash: 'nao-utilizado-nos-testes',
      role: Role.ORGANIZER,
    },
  })

  secondOrganizerId = secondOrganizer.id
  accessTokens.set(
    Role.ORGANIZER,
    app.jwt.sign({ role: Role.ORGANIZER, sub: organizer.id }),
  )
  accessTokens.set(
    'SECOND_ORGANIZER',
    app.jwt.sign({ role: Role.ORGANIZER, sub: secondOrganizer.id }),
  )
  accessTokens.set(
    Role.CUSTOMER,
    app.jwt.sign({ role: Role.CUSTOMER, sub: customer.id }),
  )
  accessTokens.set(Role.GATE, app.jwt.sign({ role: Role.GATE, sub: gate.id }))

  await removeFailureTrigger()
  await removeCreatedSessions()
})

beforeEach(async () => {
  await removeFailureTrigger()
  await removeCreatedSessions()
  movieCatalog.reset()
})

afterAll(async () => {
  try {
    await removeFailureTrigger()
    await removeCreatedSessions()

    if (secondOrganizerId) {
      await prisma.user.deleteMany({ where: { id: secondOrganizerId } })
    }
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
})

describe('POST /organizer/sessions/:id/duplicate', () => {
  it('copies the structure of a draft into a brand new draft', async () => {
    const source = await createSession()
    movieCatalog.reset()

    const response = await duplicateSession(source.id)
    expect(response.statusCode).toBe(201)

    const copy = response.json<SessionResponse>()
    createdSessionIds.add(copy.id)

    expect(copy.id).not.toBe(source.id)
    expect(copy.status).toBe(SessionStatus.DRAFT)
    expect(copy.publishedAt).toBeNull()
    expect(copy).toMatchObject({
      venueName: source.venueName,
      roomName: source.roomName,
      address: source.address,
      priceCents: source.priceCents,
      capacity: source.capacity,
      rows: source.rows,
      seatsPerRow: source.seatsPerRow,
    })
    expect(copy.movie).toEqual(source.movie)
    // O snapshot local basta: a TMDb não é consultada de novo.
    expect(movieCatalog.detailCalls).toEqual([])
  })

  it('duplicates a published session as a draft, never carrying the publication', async () => {
    const source = await createSession({ publish: true })
    expect(source.status).toBe(SessionStatus.PUBLISHED)
    expect(source.publishedAt).not.toBeNull()

    const response = await duplicateSession(source.id)
    expect(response.statusCode).toBe(201)

    const copy = response.json<SessionResponse>()
    createdSessionIds.add(copy.id)

    expect(copy.status).toBe(SessionStatus.DRAFT)
    expect(copy.publishedAt).toBeNull()
    expect(copy.editability).toEqual({
      allowed: true,
      reason: 'DRAFT',
      layoutEditable: true,
    })

    // A origem permanece intacta e publicada.
    const storedSource = await prisma.session.findUniqueOrThrow({
      where: { id: source.id },
    })
    expect(storedSource.status).toBe(SessionStatus.PUBLISHED)
    expect(storedSource.publishedAt).not.toBeNull()
  })

  it('generates brand new seats without sharing any identifier with the source', async () => {
    const source = await createSession({ publish: true })
    const sourceSeats = await prisma.seat.findMany({
      where: { sessionId: source.id },
      select: { id: true, label: true, rowLabel: true, number: true },
      orderBy: [{ rowLabel: 'asc' }, { number: 'asc' }],
    })

    const copy = (await duplicateSession(source.id)).json<SessionResponse>()
    createdSessionIds.add(copy.id)

    const copySeats = await prisma.seat.findMany({
      where: { sessionId: copy.id },
      select: { id: true, label: true, rowLabel: true, number: true },
      orderBy: [{ rowLabel: 'asc' }, { number: 'asc' }],
    })

    expect(copySeats).toHaveLength(sourceSeats.length)
    expect(copySeats.map(({ label }) => label)).toEqual(
      sourceSeats.map(({ label }) => label),
    )
    // Mesmos rótulos, identificadores completamente novos.
    const sourceIds = new Set(sourceSeats.map(({ id }) => id))
    expect(copySeats.every(({ id }) => !sourceIds.has(id))).toBe(true)
    expect(new Set(copySeats.map(({ label }) => label)).size).toBe(
      copySeats.length,
    )
  })

  it('never copies reservations, allocations, payments, tickets, or share links', async () => {
    const source = await createSession({ publish: true })
    const seats = await prisma.seat.findMany({
      where: { sessionId: source.id },
      select: { id: true },
      orderBy: [{ rowLabel: 'asc' }, { number: 'asc' }],
    })

    const hold = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: authorization(tokenFor(Role.CUSTOMER)),
      payload: { sessionId: source.id, seatIds: [seats[0]!.id, seats[1]!.id] },
    })
    expect(hold.statusCode).toBe(201)
    const reservationId = hold.json<{ id: string }>().id

    const payment = await app.inject({
      method: 'POST',
      url: `/reservations/${reservationId}/payment`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
      payload: { outcome: PaymentStatus.APPROVED },
    })
    expect(payment.statusCode).toBe(200)
    const tickets = payment.json<{ tickets: Array<{ id: string }> }>().tickets

    const share = await app.inject({
      method: 'POST',
      url: `/me/tickets/${tickets[0]!.id}/share-link`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(share.statusCode).toBe(201)

    const copy = (await duplicateSession(source.id)).json<SessionResponse>()
    createdSessionIds.add(copy.id)

    expect(
      await prisma.reservation.count({ where: { sessionId: copy.id } }),
    ).toBe(0)
    expect(await prisma.ticket.count({ where: { sessionId: copy.id } })).toBe(0)
    expect(
      await prisma.payment.count({
        where: { reservation: { sessionId: copy.id } },
      }),
    ).toBe(0)
    expect(
      await prisma.reservationSeat.count({
        where: { seat: { sessionId: copy.id } },
      }),
    ).toBe(0)
    expect(
      await prisma.sharedTicketLink.count({
        where: { ticket: { sessionId: copy.id } },
      }),
    ).toBe(0)

    // A cópia nasce com o estoque inteiro livre e sem receita.
    expect(copy.metrics).toMatchObject({
      capacity: source.capacity,
      soldSeats: 0,
      simulatedRevenueCents: 0,
    })

    // O histórico da origem continua exatamente onde estava.
    expect(
      await prisma.ticket.count({ where: { sessionId: source.id } }),
    ).toBe(2)
    expect(
      await prisma.reservation.count({ where: { sessionId: source.id } }),
    ).toBe(1)
  })

  it('enforces authentication, role, and ownership without leaking existence', async () => {
    const source = await createSession({ publish: true })

    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/organizer/sessions/${source.id}/duplicate`,
    })
    expect(unauthenticated.statusCode).toBe(401)

    for (const role of [Role.CUSTOMER, Role.GATE]) {
      expect((await duplicateSession(source.id, role)).statusCode).toBe(403)
    }

    const otherOrganizer = await duplicateSession(source.id, 'SECOND_ORGANIZER')
    expect(otherOrganizer.statusCode).toBe(404)
    expect(otherOrganizer.json()).toMatchObject({ error: 'SESSION_NOT_FOUND' })

    const invalidId = await app.inject({
      method: 'POST',
      url: '/organizer/sessions/not-a-uuid/duplicate',
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })
    expect(invalidId.statusCode).toBe(400)
    expect(invalidId.json()).toMatchObject({ error: 'VALIDATION_ERROR' })

    // Nenhuma cópia foi criada por qualquer uma das tentativas recusadas.
    expect(
      await prisma.session.count({
        where: { address: TEST_SESSION_ADDRESS },
      }),
    ).toBe(1)
  })

  it('rolls back completely when copying the seats fails', async () => {
    const source = await createSession({ publish: true })
    const sessionsBefore = await prisma.session.count({
      where: { address: TEST_SESSION_ADDRESS },
    })
    await installSeatCopyFailureTrigger()

    try {
      const response = await duplicateSession(source.id)
      expect(response.statusCode).toBe(500)

      // Nem a sessão copiada nem seus assentos sobraram.
      expect(
        await prisma.session.count({ where: { address: TEST_SESSION_ADDRESS } }),
      ).toBe(sessionsBefore)
      expect(
        await prisma.seat.count({ where: { sessionId: source.id } }),
      ).toBe(source.capacity)
    } finally {
      await removeFailureTrigger()
    }
  })
})
