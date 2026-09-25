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
import { HttpError } from '../src/http/error-response.js'
import { prisma } from '../src/lib/prisma.js'
import type {
  CatalogMovie,
  CatalogMovieDetails,
  MovieCatalog,
} from '../src/modules/catalog/catalog.types.js'

const TEST_SESSION_ADDRESS = 'Rua da Edição Segura, 303 — teste P1.1'
const SESSION_PRICE_CENTS = 3_000
const FAILURE_TRIGGER = 'P11_fail_seat_rebuild'
const FAILURE_FUNCTION = 'P11_fail_seat_rebuild_function'
const FAILURE_TABLE = 'P11EditFailure'

const movieOne: CatalogMovieDetails = {
  id: 501,
  title: 'Sessão Editável',
  overview: 'Snapshot da suíte P1.1.',
  posterPath: '/poster-501.jpg',
  backdropPath: '/backdrop-501.jpg',
  releaseDate: '2026-01-10',
  runtimeMinutes: 110,
}

const movieTwo: CatalogMovieDetails = {
  id: 502,
  title: 'Sessão Trocada',
  overview: 'Segundo snapshot da suíte P1.1.',
  posterPath: null,
  backdropPath: null,
  releaseDate: null,
  runtimeMinutes: 95,
}

class FakeMovieCatalog implements MovieCatalog {
  async listNowPlaying(): Promise<CatalogMovie[]> {
    return [movieOne]
  }

  async searchMovies(): Promise<CatalogMovie[]> {
    return [movieOne]
  }

  async getMovieDetails(tmdbMovieId: number) {
    if (tmdbMovieId === movieOne.id) {
      return movieOne
    }

    if (tmdbMovieId === movieTwo.id) {
      return movieTwo
    }

    throw new HttpError(404, 'MOVIE_NOT_FOUND', 'Filme não encontrado.')
  }
}

type EditabilityReason =
  | 'DRAFT'
  | 'PUBLISHED_SAFE'
  | 'SESSION_STARTED'
  | 'ACTIVE_HOLD'
  | 'COMMERCIAL_HISTORY'

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
  movie: { tmdbId: number; title: string }
  editability: {
    allowed: boolean
    reason: EditabilityReason
    layoutEditable: boolean
  }
}

type AuthIdentity = Role | 'SECOND_ORGANIZER' | 'SECOND_CUSTOMER'

const app = buildApp({}, { movieCatalog: new FakeMovieCatalog() })
const accessTokens = new Map<AuthIdentity, string>()
const createdSessionIds = new Set<string>()
let databaseSafetyConfirmed = false
let secondOrganizerId: string | null = null

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error(
      'Os testes de edição segura exigem NODE_ENV=test e DATABASE_URL local.',
    )
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Os testes de edição segura recusaram um PostgreSQL não local.')
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

function futureDate(hours = 48) {
  return new Date(Date.now() + hours * 60 * 60 * 1_000)
}

async function createSession(
  options: { publish?: boolean; rows?: number; seatsPerRow?: number } = {},
) {
  const { publish = false, rows = 2, seatsPerRow = 2 } = options

  const createResponse = await app.inject({
    method: 'POST',
    url: '/organizer/sessions',
    headers: authorization(tokenFor(Role.ORGANIZER)),
    payload: {
      tmdbMovieId: movieOne.id,
      startsAt: futureDate().toISOString(),
      venueName: 'Cine Edição',
      roomName: 'Sala Revisão',
      address: TEST_SESSION_ADDRESS,
      priceCents: SESSION_PRICE_CENTS,
      rows,
      seatsPerRow,
    },
  })

  expect(createResponse.statusCode).toBe(201)
  const session = createResponse.json<SessionResponse>()
  createdSessionIds.add(session.id)

  if (!publish) {
    return session
  }

  const publishResponse = await app.inject({
    method: 'POST',
    url: `/organizer/sessions/${session.id}/publish`,
    headers: authorization(tokenFor(Role.ORGANIZER)),
  })
  expect(publishResponse.statusCode).toBe(200)

  return publishResponse.json<SessionResponse>()
}

function getSession(sessionId: string, identity: AuthIdentity = Role.ORGANIZER) {
  return app.inject({
    method: 'GET',
    url: `/organizer/sessions/${sessionId}`,
    headers: authorization(tokenFor(identity)),
  })
}

function editSession(
  sessionId: string,
  payload: Record<string, unknown>,
  identity: AuthIdentity = Role.ORGANIZER,
) {
  return app.inject({
    method: 'PATCH',
    url: `/organizer/sessions/${sessionId}`,
    headers: authorization(tokenFor(identity)),
    payload,
  })
}

async function sessionSeatIds(sessionId: string) {
  const seats = await prisma.seat.findMany({
    where: { sessionId },
    select: { id: true, label: true },
    orderBy: [{ rowLabel: 'asc' }, { number: 'asc' }],
  })

  return seats
}

function createHoldRequest(sessionId: string, seatIds: string[]) {
  return app.inject({
    method: 'POST',
    url: '/reservations',
    headers: authorization(tokenFor(Role.CUSTOMER)),
    payload: { sessionId, seatIds },
  })
}

async function createPaidPurchase(sessionId: string, seatIds: string[]) {
  const hold = await createHoldRequest(sessionId, seatIds)
  expect(hold.statusCode).toBe(201)
  const reservationId = hold.json<{ id: string }>().id

  const payment = await app.inject({
    method: 'POST',
    url: `/reservations/${reservationId}/payment`,
    headers: authorization(tokenFor(Role.CUSTOMER)),
    payload: { outcome: PaymentStatus.APPROVED },
  })
  expect(payment.statusCode).toBe(200)

  return {
    reservationId,
    tickets: payment.json<{ tickets: Array<{ id: string }> }>().tickets,
  }
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

async function installSeatRebuildFailureTrigger(sessionId: string) {
  await removeFailureTrigger()
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${FAILURE_TABLE}" ("sessionId" UUID PRIMARY KEY)
  `)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${FAILURE_TABLE}" ("sessionId") VALUES ($1::uuid)`,
    sessionId,
  )
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${FAILURE_FUNCTION}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM "${FAILURE_TABLE}" WHERE "sessionId" = NEW."sessionId"
      ) THEN
        RAISE EXCEPTION 'controlled P1.1 seat rebuild failure';
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

beforeAll(async () => {
  assertLocalTestDatabase()
  await app.ready()

  const [organizer, customer, gate] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: 'organizer@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'customer1@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'gate@demo.local' } }),
  ])
  const secondOrganizer = await prisma.user.upsert({
    where: { email: 'organizer-p11@demo.local' },
    update: {},
    create: {
      email: 'organizer-p11@demo.local',
      name: 'Organizador P1.1',
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

    if (secondOrganizerId) {
      await prisma.user.deleteMany({ where: { id: secondOrganizerId } })
    }
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
})

describe('editability policy exposed by the backend', () => {
  it('reports a draft as fully editable', async () => {
    const session = await createSession()

    expect(session.editability).toEqual({
      allowed: true,
      reason: 'DRAFT',
      layoutEditable: true,
    })

    const detail = await getSession(session.id)
    expect(detail.json<SessionResponse>().editability).toEqual({
      allowed: true,
      reason: 'DRAFT',
      layoutEditable: true,
    })
  })

  it('reports a future published session without history as safely editable', async () => {
    const session = await createSession({ publish: true })

    expect(session.status).toBe(SessionStatus.PUBLISHED)
    expect(session.editability).toEqual({
      allowed: true,
      reason: 'PUBLISHED_SAFE',
      layoutEditable: true,
    })
  })

  it('reports the real reason for each blocking condition', async () => {
    const started = await createSession({ publish: true })
    await prisma.session.update({
      where: { id: started.id },
      data: { startsAt: new Date(Date.now() - 60_000) },
    })
    expect(
      (await getSession(started.id)).json<SessionResponse>().editability,
    ).toEqual({
      allowed: false,
      reason: 'SESSION_STARTED',
      layoutEditable: false,
    })

    const held = await createSession({ publish: true })
    const heldSeats = await sessionSeatIds(held.id)
    expect((await createHoldRequest(held.id, [heldSeats[0]!.id])).statusCode).toBe(
      201,
    )
    expect(
      (await getSession(held.id)).json<SessionResponse>().editability,
    ).toEqual({
      allowed: false,
      reason: 'ACTIVE_HOLD',
      layoutEditable: false,
    })

    const sold = await createSession({ publish: true })
    const soldSeats = await sessionSeatIds(sold.id)
    await createPaidPurchase(sold.id, [soldSeats[0]!.id])
    expect(
      (await getSession(sold.id)).json<SessionResponse>().editability,
    ).toEqual({
      allowed: false,
      reason: 'COMMERCIAL_HISTORY',
      layoutEditable: false,
    })
  })

  it('keeps a session blocked by any emitted ticket, including USED and CANCELLED', async () => {
    const usedSession = await createSession({ publish: true })
    const usedSeats = await sessionSeatIds(usedSession.id)
    const usedPurchase = await createPaidPurchase(usedSession.id, [
      usedSeats[0]!.id,
    ])
    const ticketDetail = await app.inject({
      method: 'GET',
      url: `/me/tickets/${usedPurchase.tickets[0]!.id}`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    const qrToken = ticketDetail.json<{ qrToken: string }>().qrToken
    const consumed = await app.inject({
      method: 'POST',
      url: '/gate/tickets/consume',
      headers: authorization(tokenFor(Role.GATE)),
      payload: { sessionId: usedSession.id, credential: qrToken },
    })
    expect(consumed.json<{ result: string }>().result).toBe('VALID')
    expect(
      (await getSession(usedSession.id)).json<SessionResponse>().editability,
    ).toMatchObject({ allowed: false, reason: 'COMMERCIAL_HISTORY' })
    expect(
      (await editSession(usedSession.id, { priceCents: 1 })).statusCode,
    ).toBe(409)

    const cancelledSession = await createSession({ publish: true })
    const cancelledSeats = await sessionSeatIds(cancelledSession.id)
    const cancelledPurchase = await createPaidPurchase(cancelledSession.id, [
      cancelledSeats[0]!.id,
    ])
    const cancellation = await app.inject({
      method: 'POST',
      url: `/reservations/${cancelledPurchase.reservationId}/cancel`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(cancellation.statusCode).toBe(200)

    // O assento voltou ao estoque, mas o ingresso CANCELLED continua sendo
    // histórico comercial que depende estruturalmente da sessão.
    expect(
      await prisma.ticket.count({
        where: {
          sessionId: cancelledSession.id,
          status: TicketStatus.CANCELLED,
        },
      }),
    ).toBe(1)
    expect(
      (await getSession(cancelledSession.id)).json<SessionResponse>()
        .editability,
    ).toMatchObject({ allowed: false, reason: 'COMMERCIAL_HISTORY' })
    expect(
      (await editSession(cancelledSession.id, { priceCents: 1 })).statusCode,
    ).toBe(409)
  })

  it('does not block forever on released history without any ticket', async () => {
    const expiredSession = await createSession({ publish: true })
    const expiredSeats = await sessionSeatIds(expiredSession.id)
    const hold = await createHoldRequest(expiredSession.id, [
      expiredSeats[0]!.id,
    ])
    expect(hold.statusCode).toBe(201)
    const reservationId = hold.json<{ id: string }>().id

    // O hold vence e é normalizado pela expiração lazy do próprio produto.
    await prisma.reservation.update({
      where: { id: reservationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })
    const lazyRead = await app.inject({
      method: 'GET',
      url: `/reservations/${reservationId}`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(lazyRead.json<{ status: ReservationStatus }>().status).toBe(
      ReservationStatus.EXPIRED,
    )

    const editability = (await getSession(expiredSession.id)).json<SessionResponse>()
      .editability
    expect(editability.allowed).toBe(true)
    expect(editability.reason).toBe('PUBLISHED_SAFE')
    // A alocação liberada permanece como histórico e impede apenas a
    // reconstrução do mapa, não a edição dos demais campos.
    expect(editability.layoutEditable).toBe(false)

    const declinedSession = await createSession({ publish: true })
    const declinedSeats = await sessionSeatIds(declinedSession.id)
    const declinedHold = await createHoldRequest(declinedSession.id, [
      declinedSeats[0]!.id,
    ])
    expect(declinedHold.statusCode).toBe(201)
    const declinedPayment = await app.inject({
      method: 'POST',
      url: `/reservations/${declinedHold.json<{ id: string }>().id}/payment`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
      payload: { outcome: PaymentStatus.DECLINED },
    })
    expect(declinedPayment.statusCode).toBe(200)
    expect(
      await prisma.ticket.count({ where: { sessionId: declinedSession.id } }),
    ).toBe(0)

    expect(
      (await getSession(declinedSession.id)).json<SessionResponse>().editability,
    ).toMatchObject({ allowed: true, reason: 'PUBLISHED_SAFE' })
    expect(
      (await editSession(declinedSession.id, { priceCents: 4_100 })).statusCode,
    ).toBe(200)
  })
})

describe('safe structural edit of a published session', () => {
  it('edits price, time, venue, room, and movie while staying PUBLISHED', async () => {
    const session = await createSession({ publish: true })
    const newStartsAt = futureDate(72)

    const response = await editSession(session.id, {
      priceCents: 5_500,
      startsAt: newStartsAt.toISOString(),
      venueName: 'Cine Revisado',
      roomName: 'Sala Nova',
      address: TEST_SESSION_ADDRESS,
      tmdbMovieId: movieTwo.id,
    })

    expect(response.statusCode).toBe(200)
    const updated = response.json<SessionResponse>()
    expect(updated).toMatchObject({
      status: SessionStatus.PUBLISHED,
      priceCents: 5_500,
      venueName: 'Cine Revisado',
      roomName: 'Sala Nova',
    })
    expect(updated.movie.tmdbId).toBe(movieTwo.id)
    expect(new Date(updated.startsAt).toISOString()).toBe(
      newStartsAt.toISOString(),
    )
    // publishedAt é preservado: a sessão nunca volta a ser rascunho.
    expect(updated.publishedAt).toBe(session.publishedAt)
    expect(updated.publishedAt).not.toBeNull()

    const stored = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    })
    expect(stored.status).toBe(SessionStatus.PUBLISHED)
    expect(stored.publishedAt?.toISOString()).toBe(
      new Date(session.publishedAt!).toISOString(),
    )
    expect(stored.priceCents).toBe(5_500)
  })

  it('rebuilds the layout without orphans or duplicated labels', async () => {
    const session = await createSession({ publish: true, rows: 2, seatsPerRow: 2 })
    const originalSeatIds = (await sessionSeatIds(session.id)).map(
      ({ id }) => id,
    )

    const response = await editSession(session.id, { rows: 3, seatsPerRow: 4 })
    expect(response.statusCode).toBe(200)
    expect(response.json<SessionResponse>()).toMatchObject({
      capacity: 12,
      rows: 3,
      seatsPerRow: 4,
    })

    const seats = await sessionSeatIds(session.id)
    const labels = seats.map(({ label }) => label)
    expect(seats).toHaveLength(12)
    expect(new Set(labels).size).toBe(12)
    // Nenhum assento antigo sobrou órfão.
    expect(
      await prisma.seat.count({ where: { id: { in: originalSeatIds } } }),
    ).toBe(0)
    expect(
      await prisma.seat.count({ where: { sessionId: session.id } }),
    ).toBe(12)

    const seatMap = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}/seats`,
    })
    expect(seatMap.json<{ seats: unknown[] }>().seats).toHaveLength(12)
  })

  it('refuses to rebuild the layout when seat history exists, without touching it', async () => {
    const session = await createSession({ publish: true })
    const seats = await sessionSeatIds(session.id)
    const hold = await createHoldRequest(session.id, [seats[0]!.id])
    expect(hold.statusCode).toBe(201)
    await prisma.reservation.update({
      where: { id: hold.json<{ id: string }>().id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })
    await app.inject({
      method: 'GET',
      url: `/reservations/${hold.json<{ id: string }>().id}`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })

    const response = await editSession(session.id, { rows: 3, seatsPerRow: 3 })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: 'SESSION_LAYOUT_NOT_EDITABLE',
    })

    const stored = await sessionSeatIds(session.id)
    expect(stored.map(({ id }) => id)).toEqual(seats.map(({ id }) => id))

    // Os demais campos continuam editáveis.
    expect((await editSession(session.id, { priceCents: 7_200 })).statusCode).toBe(
      200,
    )
  })

  it('blocks the edit for a started session, an active hold, and a paid purchase', async () => {
    const started = await createSession({ publish: true })
    await prisma.session.update({
      where: { id: started.id },
      data: { startsAt: new Date(Date.now() - 60_000) },
    })
    const startedResponse = await editSession(started.id, { priceCents: 1 })
    expect(startedResponse.statusCode).toBe(409)
    expect(startedResponse.json()).toMatchObject({
      error: 'SESSION_NOT_EDITABLE',
      message: expect.stringContaining('já começou'),
    })

    const held = await createSession({ publish: true })
    const heldSeats = await sessionSeatIds(held.id)
    expect((await createHoldRequest(held.id, [heldSeats[0]!.id])).statusCode).toBe(
      201,
    )
    const heldResponse = await editSession(held.id, { priceCents: 1 })
    expect(heldResponse.statusCode).toBe(409)
    expect(heldResponse.json()).toMatchObject({ error: 'SESSION_NOT_EDITABLE' })

    const sold = await createSession({ publish: true })
    const soldSeats = await sessionSeatIds(sold.id)
    await createPaidPurchase(sold.id, [soldSeats[0]!.id])
    const soldResponse = await editSession(sold.id, { priceCents: 1 })
    expect(soldResponse.statusCode).toBe(409)
    expect(soldResponse.json()).toMatchObject({
      error: 'SESSION_NOT_EDITABLE',
      message: expect.stringContaining('reservas ou ingressos'),
    })

    for (const sessionId of [started.id, held.id, sold.id]) {
      expect(
        await prisma.session.findUniqueOrThrow({
          where: { id: sessionId },
          select: { priceCents: true },
        }),
      ).toEqual({ priceCents: SESSION_PRICE_CENTS })
    }
  })

  it('enforces authentication, role, and ownership without leaking existence', async () => {
    const session = await createSession({ publish: true })

    const unauthenticated = await app.inject({
      method: 'PATCH',
      url: `/organizer/sessions/${session.id}`,
      payload: { priceCents: 1 },
    })
    expect(unauthenticated.statusCode).toBe(401)

    for (const role of [Role.CUSTOMER, Role.GATE]) {
      expect((await editSession(session.id, { priceCents: 1 }, role)).statusCode).toBe(
        403,
      )
    }

    const otherOrganizer = await editSession(
      session.id,
      { priceCents: 1 },
      'SECOND_ORGANIZER',
    )
    expect(otherOrganizer.statusCode).toBe(404)
    expect(otherOrganizer.json()).toMatchObject({ error: 'SESSION_NOT_FOUND' })
    expect((await getSession(session.id, 'SECOND_ORGANIZER')).statusCode).toBe(404)

    expect(
      await prisma.session.findUniqueOrThrow({
        where: { id: session.id },
        select: { priceCents: true },
      }),
    ).toEqual({ priceCents: SESSION_PRICE_CENTS })
  })

  it('rolls back the whole edit when the seat rebuild fails', async () => {
    const session = await createSession({ publish: true, rows: 2, seatsPerRow: 2 })
    const originalSeats = await sessionSeatIds(session.id)
    await installSeatRebuildFailureTrigger(session.id)

    try {
      const response = await editSession(session.id, {
        priceCents: 9_900,
        rows: 4,
        seatsPerRow: 4,
      })
      expect(response.statusCode).toBe(500)

      const stored = await prisma.session.findUniqueOrThrow({
        where: { id: session.id },
      })
      expect(stored.priceCents).toBe(SESSION_PRICE_CENTS)
      expect(stored.status).toBe(SessionStatus.PUBLISHED)

      const seats = await sessionSeatIds(session.id)
      expect(seats.map(({ id }) => id)).toEqual(
        originalSeats.map(({ id }) => id),
      )
    } finally {
      await removeFailureTrigger()
    }
  })
})

describe('reservation versus edit concurrency', () => {
  it('serializes the edit behind an in-flight reservation and then blocks it', async () => {
    const session = await createSession({ publish: true })
    const seats = await sessionSeatIds(session.id)
    const connectionString = process.env.DATABASE_URL!
    const blocker = new Client({ connectionString })
    const observer = new Client({ connectionString })
    let blockerConnected = false
    let observerConnected = false
    let blockerTransactionOpen = false
    let holdRequest: ReturnType<typeof createHoldRequest> | null = null
    let editRequest: ReturnType<typeof editSession> | null = null

    try {
      await blocker.connect()
      blockerConnected = true
      await observer.connect()
      observerConnected = true
      await blocker.query('BEGIN')
      blockerTransactionOpen = true
      // Segura o assento para que a reserva pare depois de já ter travado a
      // Session em FOR SHARE.
      await blocker.query(
        'SELECT "id" FROM "Seat" WHERE "id" = $1::uuid FOR UPDATE',
        [seats[0]!.id],
      )

      holdRequest = createHoldRequest(session.id, [seats[0]!.id])
      await waitForBlockedQueries(observer, 'create-hold-lock-seats')

      // A edição precisa esperar o FOR SHARE da reserva ser liberado.
      editRequest = editSession(session.id, { priceCents: 8_800 })
      await waitForBlockedQueries(observer, 'update-session-lock-session')

      await blocker.query('COMMIT')
      blockerTransactionOpen = false

      const [hold, edit] = await Promise.all([holdRequest, editRequest])

      expect(hold.statusCode).toBe(201)
      // A reserva venceu: a edição acorda, revalida e é recusada pelo hold.
      expect(edit.statusCode).toBe(409)
      expect(edit.json()).toMatchObject({ error: 'SESSION_NOT_EDITABLE' })

      const stored = await prisma.session.findUniqueOrThrow({
        where: { id: session.id },
        select: { priceCents: true },
      })
      expect(stored.priceCents).toBe(SESSION_PRICE_CENTS)

      // O preço da alocação é o que a reserva leu sob lock, nunca um stale.
      const allocations = await prisma.reservationSeat.findMany({
        where: { reservationId: hold.json<{ id: string }>().id },
        select: { unitPriceCents: true },
      })
      expect(allocations).toEqual([{ unitPriceCents: SESSION_PRICE_CENTS }])
    } finally {
      if (blockerTransactionOpen && blockerConnected) {
        await Promise.allSettled([blocker.query('ROLLBACK')])
      }
      await Promise.allSettled(
        [holdRequest, editRequest].filter(
          (request): request is NonNullable<typeof request> => request !== null,
        ),
      )
      await Promise.allSettled([
        blockerConnected ? blocker.end() : Promise.resolve(),
        observerConnected ? observer.end() : Promise.resolve(),
      ])
    }
  }, 20_000)

  it('makes a reservation that starts after the edit use the new price', async () => {
    const session = await createSession({ publish: true })
    const seats = await sessionSeatIds(session.id)

    const edit = await editSession(session.id, { priceCents: 6_400 })
    expect(edit.statusCode).toBe(200)

    const hold = await createHoldRequest(session.id, [seats[0]!.id])
    expect(hold.statusCode).toBe(201)

    const reservation = hold.json<{ id: string; totalCents: number }>()
    expect(reservation.totalCents).toBe(6_400)

    const allocations = await prisma.reservationSeat.findMany({
      where: { reservationId: reservation.id },
      select: { unitPriceCents: true },
    })
    expect(allocations).toEqual([{ unitPriceCents: 6_400 }])
  })
})
