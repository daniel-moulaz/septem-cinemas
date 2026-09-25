import { randomBytes } from 'node:crypto'
import * as argon2 from 'argon2'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { Role, SessionStatus } from '../src/generated/prisma/enums.js'
import { HttpError } from '../src/http/error-response.js'
import { prisma } from '../src/lib/prisma.js'
import type {
  CatalogMovie,
  CatalogMovieDetails,
  MovieCatalog,
} from '../src/modules/catalog/catalog.types.js'

const movieOne: CatalogMovieDetails = {
  id: 101,
  title: 'O Filme de Teste',
  overview: 'Snapshot confiável vindo do catálogo de teste.',
  posterPath: '/poster-101.jpg',
  backdropPath: '/backdrop-101.jpg',
  releaseDate: '2025-08-14',
  runtimeMinutes: 123,
}

const movieTwo: CatalogMovieDetails = {
  id: 202,
  title: 'Outro Filme',
  overview: 'Segundo snapshot para testar a troca do filme.',
  posterPath: null,
  backdropPath: '/backdrop-202.jpg',
  releaseDate: null,
  runtimeMinutes: 97,
}

const TEST_SESSION_ADDRESS = 'Rua das Telas, 100 — teste M2'

class FakeMovieCatalog implements MovieCatalog {
  readonly detailCalls: number[] = []

  async listNowPlaying(): Promise<CatalogMovie[]> {
    return [movieOne]
  }

  async searchMovies(): Promise<CatalogMovie[]> {
    return [movieOne]
  }

  async getMovieDetails(tmdbMovieId: number) {
    this.detailCalls.push(tmdbMovieId)

    if (tmdbMovieId === movieOne.id) {
      return movieOne
    }

    if (tmdbMovieId === movieTwo.id) {
      return movieTwo
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
  movie: CatalogMovieDetails & { tmdbId: number }
}

const catalog = new FakeMovieCatalog()
const app = buildApp({}, { movieCatalog: catalog })
const accessTokens = new Map<Role | 'SECOND_ORGANIZER', string>()
const createdSessionIds = new Set<string>()
let databaseSafetyConfirmed = false
let organizerId: string | null = null
let secondOrganizerId: string | null = null

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error('Os testes de sessão exigem NODE_ENV=test e DATABASE_URL local.')
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error(
      'Os testes de sessão recusaram um PostgreSQL que não é local.',
    )
  }

  databaseSafetyConfirmed = true
}

function requireOrganizerIds() {
  if (!organizerId || !secondOrganizerId) {
    throw new Error('Os organizadores de teste ainda não foram inicializados.')
  }

  return { organizerId, secondOrganizerId }
}

function authorization(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` }
}

function tokenFor(role: Role | 'SECOND_ORGANIZER') {
  const accessToken = accessTokens.get(role)

  if (!accessToken) {
    throw new Error(`Token de teste ausente para ${role}.`)
  }

  return accessToken
}

function futureDate(days = 2) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString()
}

function validSessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    tmdbMovieId: movieOne.id,
    startsAt: futureDate(),
    venueName: 'Cinema Central',
    roomName: 'Sala 2',
    address: TEST_SESSION_ADDRESS,
    priceCents: 3_000,
    rows: 2,
    seatsPerRow: 3,
    ...overrides,
  }
}

async function createSession(
  accessToken = tokenFor(Role.ORGANIZER),
  overrides: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/organizer/sessions',
    headers: authorization(accessToken),
    payload: validSessionPayload(overrides),
  })

  expect(response.statusCode).toBe(201)

  const session = response.json<SessionResponse>()
  createdSessionIds.add(session.id)

  return session
}

async function removeCreatedSessions() {
  if (createdSessionIds.size === 0) {
    return
  }

  await prisma.session.deleteMany({
    where: { id: { in: Array.from(createdSessionIds) } },
  })
  createdSessionIds.clear()
}

function countTestSessions() {
  return prisma.session.count({ where: { address: TEST_SESSION_ADDRESS } })
}

function countTestSeats() {
  return prisma.seat.count({
    where: { session: { address: TEST_SESSION_ADDRESS } },
  })
}

async function removeFailureTrigger() {
  if (!databaseSafetyConfirmed) {
    throw new Error('Cleanup recusado sem confirmação do banco local de teste.')
  }

  await prisma.$executeRaw`
    DROP TRIGGER IF EXISTS "m2_fail_seat_insert" ON "Seat"
  `
  await prisma.$executeRaw`
    DROP FUNCTION IF EXISTS m2_fail_seat_insert()
  `
}

beforeAll(async () => {
  assertLocalTestDatabase()
  await app.ready()

  const organizer = await prisma.user.findUniqueOrThrow({
    where: { email: 'organizer@demo.local' },
  })
  const customer = await prisma.user.findUniqueOrThrow({
    where: { email: 'customer1@demo.local' },
  })
  const gate = await prisma.user.findUniqueOrThrow({
    where: { email: 'gate@demo.local' },
  })
  const secondOrganizer = await prisma.user.upsert({
    where: { email: 'organizer.m2-tests@demo.local' },
    update: { role: Role.ORGANIZER },
    create: {
      name: 'Segundo Organizador de Teste',
      email: 'organizer.m2-tests@demo.local',
      passwordHash: await argon2.hash(randomBytes(32), {
        type: argon2.argon2id,
      }),
      role: Role.ORGANIZER,
    },
  })

  organizerId = organizer.id
  secondOrganizerId = secondOrganizer.id
  const initializedOrganizerIds = requireOrganizerIds()

  await prisma.session.deleteMany({
    where: {
      organizerId: {
        in: [
          initializedOrganizerIds.organizerId,
          initializedOrganizerIds.secondOrganizerId,
        ],
      },
      address: TEST_SESSION_ADDRESS,
    },
  })

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
  accessTokens.set(
    'SECOND_ORGANIZER',
    app.jwt.sign({ role: Role.ORGANIZER, sub: secondOrganizer.id }),
  )
})

beforeEach(async () => {
  catalog.reset()
  await removeFailureTrigger()
  await removeCreatedSessions()
})

afterAll(async () => {
  try {
    if (databaseSafetyConfirmed) {
      await removeFailureTrigger()
      await removeCreatedSessions()

      if (secondOrganizerId) {
        await prisma.session.deleteMany({
          where: { organizerId: secondOrganizerId },
        })
        await prisma.user.deleteMany({ where: { id: secondOrganizerId } })
      }
    }
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
})

describe('catalog route authorization', () => {
  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/catalog/movies',
    })

    expect(response.statusCode).toBe(401)
  })

  it.each([Role.CUSTOMER, Role.GATE])('rejects the %s role', async (role) => {
    const response = await app.inject({
      method: 'GET',
      url: '/catalog/movies',
      headers: authorization(tokenFor(role)),
    })

    expect(response.statusCode).toBe(403)
  })

  it('allows an ORGANIZER to use the catalog', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/catalog/movies',
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ movies: CatalogMovie[] }>().movies).toHaveLength(1)
  })
})

describe('POST /organizer/sessions', () => {
  it.each([Role.CUSTOMER, Role.GATE])(
    'rejects the %s role',
    async (role) => {
      const response = await app.inject({
        method: 'POST',
        url: '/organizer/sessions',
        headers: authorization(tokenFor(role)),
        payload: validSessionPayload(),
      })

      expect(response.statusCode).toBe(403)
      expect(await countTestSessions()).toBe(0)
    },
  )

  it('creates an owned DRAFT with a trusted movie snapshot and generated seats', async () => {
    const session = await createSession()

    expect(session).toMatchObject({
      status: SessionStatus.DRAFT,
      venueName: 'Cinema Central',
      priceCents: 3_000,
      publishedAt: null,
      capacity: 6,
      rows: 2,
      seatsPerRow: 3,
      movie: {
        tmdbId: movieOne.id,
        title: movieOne.title,
        overview: movieOne.overview,
        releaseDate: movieOne.releaseDate,
        runtimeMinutes: movieOne.runtimeMinutes,
      },
    })

    const stored = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
      include: { seats: { orderBy: { label: 'asc' } } },
    })

    expect(stored.organizerId).toBe(requireOrganizerIds().organizerId)
    expect(stored.movieTitle).toBe(movieOne.title)
    expect(stored.seats.map((seat) => seat.label)).toEqual([
      'A1',
      'A2',
      'A3',
      'B1',
      'B2',
      'B3',
    ])
    expect(catalog.detailCalls).toEqual([movieOne.id])
  })

  it('rejects organizerId and movie snapshot fields supplied by the client', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/organizer/sessions',
      headers: authorization(tokenFor(Role.ORGANIZER)),
      payload: validSessionPayload({
        organizerId: requireOrganizerIds().secondOrganizerId,
        movieTitle: 'Título falsificado',
      }),
    })

    expect(response.statusCode).toBe(400)
    expect(await countTestSessions()).toBe(0)
    expect(catalog.detailCalls).toEqual([])
  })

  it.each([
    ['past date', { startsAt: new Date(Date.now() - 60_000).toISOString() }],
    ['negative price', { priceCents: -1 }],
    ['no rows', { rows: 0 }],
    ['too many rows', { rows: 11 }],
    ['no seats per row', { seatsPerRow: 0 }],
    ['too many seats per row', { seatsPerRow: 21 }],
  ])('rejects invalid input: %s', async (_label, overrides) => {
    const response = await app.inject({
      method: 'POST',
      url: '/organizer/sessions',
      headers: authorization(tokenFor(Role.ORGANIZER)),
      payload: validSessionPayload(overrides),
    })

    expect(response.statusCode).toBe(400)
    expect(await countTestSessions()).toBe(0)
  })

  it('does not persist a partial session when the movie does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/organizer/sessions',
      headers: authorization(tokenFor(Role.ORGANIZER)),
      payload: validSessionPayload({ tmdbMovieId: 404 }),
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: 'MOVIE_NOT_FOUND',
      message: 'Filme não encontrado.',
    })
    expect(await countTestSessions()).toBe(0)
    expect(await countTestSeats()).toBe(0)
  })
})

describe('organizer session ownership and listing', () => {
  it('lists only sessions owned by the authenticated organizer', async () => {
    const ownSession = await createSession()
    const otherOrganizerSession = await createSession(
      tokenFor('SECOND_ORGANIZER'),
      {
        venueName: 'Cinema de Outro Organizador',
      },
    )

    const response = await app.inject({
      method: 'GET',
      url: '/organizer/sessions',
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })

    expect(response.statusCode).toBe(200)
    const sessions = response.json<{ sessions: SessionResponse[] }>().sessions

    expect(sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ownSession.id })]),
    )
    expect(sessions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: otherOrganizerSession.id }),
      ]),
    )
  })

  it('allows the owner to read the session details', async () => {
    const session = await createSession()
    const response = await app.inject({
      method: 'GET',
      url: `/organizer/sessions/${session.id}`,
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<SessionResponse>()).toMatchObject({
      id: session.id,
      capacity: 6,
      rows: 2,
      seatsPerRow: 3,
    })
  })

  it.each([
    ['GET', ''],
    ['PATCH', ''],
    ['POST', '/publish'],
  ] as const)(
    'hides another organizer session on %s',
    async (method, suffix) => {
      const session = await createSession()
      const response = await app.inject({
        method,
        url: `/organizer/sessions/${session.id}${suffix}`,
        headers: authorization(tokenFor('SECOND_ORGANIZER')),
        ...(method === 'PATCH' ? { payload: { venueName: 'Invasão' } } : {}),
      })

      expect(response.statusCode).toBe(404)
      expect(response.json()).toEqual({
        error: 'SESSION_NOT_FOUND',
        message: 'Sessão não encontrada.',
      })
    },
  )
})

describe('PATCH /organizer/sessions/:id', () => {
  it('edits a DRAFT, regenerates its layout, and only reloads a changed movie', async () => {
    const created = await createSession()

    const layoutResponse = await app.inject({
      method: 'PATCH',
      url: `/organizer/sessions/${created.id}`,
      headers: authorization(tokenFor(Role.ORGANIZER)),
      payload: {
        venueName: 'Cinema Atualizado',
        rows: 3,
        seatsPerRow: 2,
      },
    })

    expect(layoutResponse.statusCode).toBe(200)
    expect(layoutResponse.json<SessionResponse>()).toMatchObject({
      venueName: 'Cinema Atualizado',
      capacity: 6,
      rows: 3,
      seatsPerRow: 2,
    })
    expect(catalog.detailCalls).toEqual([movieOne.id])

    const labels = await prisma.seat.findMany({
      where: { sessionId: created.id },
      orderBy: { label: 'asc' },
      select: { label: true },
    })
    expect(labels.map(({ label }) => label)).toEqual([
      'A1',
      'A2',
      'B1',
      'B2',
      'C1',
      'C2',
    ])

    const movieResponse = await app.inject({
      method: 'PATCH',
      url: `/organizer/sessions/${created.id}`,
      headers: authorization(tokenFor(Role.ORGANIZER)),
      payload: { tmdbMovieId: movieTwo.id },
    })

    expect(movieResponse.statusCode).toBe(200)
    expect(movieResponse.json<SessionResponse>().movie).toMatchObject({
      tmdbId: movieTwo.id,
      title: movieTwo.title,
      posterPath: null,
      releaseDate: null,
    })
    expect(catalog.detailCalls).toEqual([movieOne.id, movieTwo.id])
  })

  it('requires both layout dimensions when changing the layout', async () => {
    const session = await createSession()
    const response = await app.inject({
      method: 'PATCH',
      url: `/organizer/sessions/${session.id}`,
      headers: authorization(tokenFor(Role.ORGANIZER)),
      payload: { rows: 4 },
    })

    expect(response.statusCode).toBe(400)
    expect((await prisma.seat.count({ where: { sessionId: session.id } }))).toBe(
      6,
    )
  })

  it('rolls back session fields and deleted seats if layout regeneration fails', async () => {
    const session = await createSession()

    await prisma.$executeRaw`
      CREATE FUNCTION m2_fail_seat_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced seat insert failure';
      END;
      $$ LANGUAGE plpgsql
    `
    await prisma.$executeRaw`
      CREATE TRIGGER "m2_fail_seat_insert"
      BEFORE INSERT ON "Seat"
      FOR EACH ROW EXECUTE FUNCTION m2_fail_seat_insert()
    `

    try {
      const response = await app.inject({
        method: 'PATCH',
        url: `/organizer/sessions/${session.id}`,
        headers: authorization(tokenFor(Role.ORGANIZER)),
        payload: {
          venueName: 'Não deve persistir',
          rows: 3,
          seatsPerRow: 4,
        },
      })

      expect(response.statusCode).toBe(500)

      const stored = await prisma.session.findUniqueOrThrow({
        where: { id: session.id },
        include: { seats: true },
      })
      expect(stored.venueName).toBe('Cinema Central')
      expect(stored.seats).toHaveLength(6)
    } finally {
      await removeFailureTrigger()
    }
  })
})

describe('POST /organizer/sessions/:id/publish', () => {
  it('publishes a DRAFT and defines publishedAt', async () => {
    const created = await createSession()
    const response = await app.inject({
      method: 'POST',
      url: `/organizer/sessions/${created.id}/publish`,
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<SessionResponse>()).toMatchObject({
      id: created.id,
      status: SessionStatus.PUBLISHED,
    })
    expect(response.json<SessionResponse>().publishedAt).toEqual(
      expect.any(String),
    )

    const stored = await prisma.session.findUniqueOrThrow({
      where: { id: created.id },
    })
    expect(stored.status).toBe(SessionStatus.PUBLISHED)
    expect(stored.publishedAt).not.toBeNull()
  })

  it('keeps a published session published and refuses a second publication', async () => {
    const created = await createSession()
    const publishResponse = await app.inject({
      method: 'POST',
      url: `/organizer/sessions/${created.id}/publish`,
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })
    expect(publishResponse.statusCode).toBe(200)

    const republishResponse = await app.inject({
      method: 'POST',
      url: `/organizer/sessions/${created.id}/publish`,
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })

    expect(republishResponse.statusCode).toBe(409)
    expect(republishResponse.json()).toMatchObject({
      error: 'SESSION_ALREADY_PUBLISHED',
    })

    // A imutabilidade absoluta de PUBLISHED foi substituída pela política de
    // edição segura (ADR-022); a cobertura completa vive em
    // session-editability.integration.test.ts.
    const stored = await prisma.session.findUniqueOrThrow({
      where: { id: created.id },
    })
    expect(stored.status).toBe(SessionStatus.PUBLISHED)
    expect(stored.publishedAt).not.toBeNull()
  })

  it('rejects a DRAFT whose start time is no longer in the future', async () => {
    const created = await createSession()
    await prisma.session.update({
      where: { id: created.id },
      data: { startsAt: new Date(Date.now() - 60_000) },
    })

    const response = await app.inject({
      method: 'POST',
      url: `/organizer/sessions/${created.id}/publish`,
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'SESSION_NOT_PUBLISHABLE' })
  })

  it('rejects a DRAFT without seats', async () => {
    const created = await createSession()
    await prisma.seat.deleteMany({ where: { sessionId: created.id } })

    const response = await app.inject({
      method: 'POST',
      url: `/organizer/sessions/${created.id}/publish`,
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'SESSION_NOT_PUBLISHABLE' })
    expect(
      await prisma.session.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ status: SessionStatus.DRAFT, publishedAt: null })
  })
})
