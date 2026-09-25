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

const TEST_SESSION_ADDRESS = 'Rua do Painel, 404 — teste P1.2'
const SESSION_PRICE_CENTS = 2_800

const movie: CatalogMovieDetails = {
  id: 601,
  title: 'Painel Operacional',
  overview: 'Snapshot da suíte P1.2.',
  posterPath: '/poster-601.jpg',
  backdropPath: null,
  releaseDate: '2026-04-02',
  runtimeMinutes: 104,
}

class FakeMovieCatalog implements MovieCatalog {
  async listNowPlaying(): Promise<CatalogMovie[]> {
    return [movie]
  }

  async searchMovies(): Promise<CatalogMovie[]> {
    return [movie]
  }

  async getMovieDetails(tmdbMovieId: number) {
    if (tmdbMovieId === movie.id) {
      return movie
    }

    throw new HttpError(404, 'MOVIE_NOT_FOUND', 'Filme não encontrado.')
  }
}

interface SessionMetrics {
  capacity: number
  availableSeats: number
  heldSeats: number
  soldSeats: number
  occupancyPercentage: number
  simulatedRevenueCents: number
}

interface SessionResponse {
  id: string
  status: SessionStatus
  capacity: number
  metrics: SessionMetrics
}

type AuthIdentity = Role | 'SECOND_CUSTOMER'

const app = buildApp({}, { movieCatalog: new FakeMovieCatalog() })
const accessTokens = new Map<AuthIdentity, string>()
const createdSessionIds = new Set<string>()
let databaseSafetyConfirmed = false

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error('Os testes de métricas exigem NODE_ENV=test e DATABASE_URL local.')
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Os testes de métricas recusaram um PostgreSQL não local.')
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

async function createPublishedSession(rows = 2, seatsPerRow = 2) {
  const created = await app.inject({
    method: 'POST',
    url: '/organizer/sessions',
    headers: authorization(tokenFor(Role.ORGANIZER)),
    payload: {
      tmdbMovieId: movie.id,
      startsAt: new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString(),
      venueName: 'Cine Painel',
      roomName: 'Sala Métrica',
      address: TEST_SESSION_ADDRESS,
      priceCents: SESSION_PRICE_CENTS,
      rows,
      seatsPerRow,
    },
  })
  expect(created.statusCode).toBe(201)
  const sessionId = created.json<SessionResponse>().id
  createdSessionIds.add(sessionId)

  const published = await app.inject({
    method: 'POST',
    url: `/organizer/sessions/${sessionId}/publish`,
    headers: authorization(tokenFor(Role.ORGANIZER)),
  })
  expect(published.statusCode).toBe(200)

  const seats = await prisma.seat.findMany({
    where: { sessionId },
    select: { id: true, label: true },
    orderBy: [{ rowLabel: 'asc' }, { number: 'asc' }],
  })

  return { id: sessionId, seats }
}

async function readMetrics(sessionId: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/organizer/sessions/${sessionId}`,
    headers: authorization(tokenFor(Role.ORGANIZER)),
  })
  expect(response.statusCode).toBe(200)

  return response.json<SessionResponse>().metrics
}

async function createHold(
  sessionId: string,
  seatIds: string[],
  identity: AuthIdentity = Role.CUSTOMER,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/reservations',
    headers: authorization(tokenFor(identity)),
    payload: { sessionId, seatIds },
  })
  expect(response.statusCode).toBe(201)

  return response.json<{ id: string }>().id
}

async function payReservation(
  reservationId: string,
  outcome: PaymentStatus,
  identity: AuthIdentity = Role.CUSTOMER,
) {
  const response = await app.inject({
    method: 'POST',
    url: `/reservations/${reservationId}/payment`,
    headers: authorization(tokenFor(identity)),
    payload: { outcome },
  })
  expect(response.statusCode).toBe(200)

  return response.json<{ tickets: Array<{ id: string }> }>()
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

beforeAll(async () => {
  assertLocalTestDatabase()
  await app.ready()

  const [organizer, customerOne, customerTwo, gate] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: 'organizer@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'customer1@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'customer2@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'gate@demo.local' } }),
  ])

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

describe('operational session metrics', () => {
  it('reports an empty session as fully available with no revenue', async () => {
    const session = await createPublishedSession(2, 2)

    expect(await readMetrics(session.id)).toEqual({
      capacity: 4,
      availableSeats: 4,
      heldSeats: 0,
      soldSeats: 0,
      occupancyPercentage: 0,
      simulatedRevenueCents: 0,
    })
  })

  it('counts an active hold as held, never as sold or as revenue', async () => {
    const session = await createPublishedSession(2, 2)
    await createHold(session.id, [session.seats[0]!.id])

    expect(await readMetrics(session.id)).toEqual({
      capacity: 4,
      availableSeats: 3,
      heldSeats: 1,
      soldSeats: 0,
      occupancyPercentage: 0,
      simulatedRevenueCents: 0,
    })
  })

  it('stops counting a hold once it expires, using the database clock', async () => {
    const session = await createPublishedSession(2, 2)
    const reservationId = await createHold(session.id, [session.seats[0]!.id])

    await prisma.reservation.update({
      where: { id: reservationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })

    // Sem nenhuma normalização lazy: a métrica já ignora o hold vencido.
    expect(await readMetrics(session.id)).toMatchObject({
      heldSeats: 0,
      soldSeats: 0,
      availableSeats: 4,
    })
  })

  it('counts a paid purchase as sold and sums its revenue per seat', async () => {
    const session = await createPublishedSession(2, 2)
    const reservationId = await createHold(session.id, [
      session.seats[0]!.id,
      session.seats[1]!.id,
    ])
    await payReservation(reservationId, PaymentStatus.APPROVED)

    expect(await readMetrics(session.id)).toEqual({
      capacity: 4,
      availableSeats: 2,
      heldSeats: 0,
      soldSeats: 2,
      occupancyPercentage: 50,
      simulatedRevenueCents: SESSION_PRICE_CENTS * 2,
    })
  })

  it('releases a declined payment back into availability', async () => {
    const session = await createPublishedSession(2, 2)
    const reservationId = await createHold(session.id, [session.seats[0]!.id])
    await payReservation(reservationId, PaymentStatus.DECLINED)

    expect(await readMetrics(session.id)).toMatchObject({
      availableSeats: 4,
      heldSeats: 0,
      soldSeats: 0,
      simulatedRevenueCents: 0,
    })
  })

  it('drops only the cancelled seat from a partially cancelled purchase', async () => {
    const session = await createPublishedSession(2, 2)
    const reservationId = await createHold(session.id, [
      session.seats[0]!.id,
      session.seats[1]!.id,
    ])
    const payment = await payReservation(reservationId, PaymentStatus.APPROVED)

    const ticketToCancel = await prisma.ticket.findFirstOrThrow({
      where: {
        id: { in: payment.tickets.map(({ id }) => id) },
        reservationSeat: { seatId: session.seats[0]!.id },
      },
      select: { id: true },
    })
    const cancellation = await app.inject({
      method: 'POST',
      url: `/me/tickets/${ticketToCancel.id}/cancel`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(cancellation.statusCode).toBe(200)

    // Receita operacional cai para um assento; o Payment aprovado segue
    // intacto como histórico financeiro bruto.
    expect(await readMetrics(session.id)).toEqual({
      capacity: 4,
      availableSeats: 3,
      heldSeats: 0,
      soldSeats: 1,
      occupancyPercentage: 25,
      simulatedRevenueCents: SESSION_PRICE_CENTS,
    })
    expect(
      await prisma.payment.findUniqueOrThrow({
        where: { reservationId },
        select: { status: true, amountCents: true },
      }),
    ).toEqual({
      status: PaymentStatus.APPROVED,
      amountCents: SESSION_PRICE_CENTS * 2,
    })
  })

  it('zeroes sold seats and revenue after a full purchase cancellation', async () => {
    const session = await createPublishedSession(2, 2)
    const reservationId = await createHold(session.id, [
      session.seats[0]!.id,
      session.seats[1]!.id,
    ])
    await payReservation(reservationId, PaymentStatus.APPROVED)

    const cancellation = await app.inject({
      method: 'POST',
      url: `/reservations/${reservationId}/cancel`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(cancellation.statusCode).toBe(200)

    expect(await readMetrics(session.id)).toEqual({
      capacity: 4,
      availableSeats: 4,
      heldSeats: 0,
      soldSeats: 0,
      occupancyPercentage: 0,
      simulatedRevenueCents: 0,
    })
  })

  it('keeps a USED ticket counted as sold revenue', async () => {
    const session = await createPublishedSession(2, 2)
    const reservationId = await createHold(session.id, [session.seats[0]!.id])
    const payment = await payReservation(reservationId, PaymentStatus.APPROVED)

    const ticketDetail = await app.inject({
      method: 'GET',
      url: `/me/tickets/${payment.tickets[0]!.id}`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    const consumed = await app.inject({
      method: 'POST',
      url: '/gate/tickets/consume',
      headers: authorization(tokenFor(Role.GATE)),
      payload: {
        sessionId: session.id,
        credential: ticketDetail.json<{ qrToken: string }>().qrToken,
      },
    })
    expect(consumed.json<{ result: string }>().result).toBe('VALID')

    // Entrar na sala não devolve o assento nem apaga a receita.
    expect(await readMetrics(session.id)).toMatchObject({
      soldSeats: 1,
      availableSeats: 3,
      simulatedRevenueCents: SESSION_PRICE_CENTS,
    })
  })

  it('does not multiply counts or revenue when several purchases share the session', async () => {
    const session = await createPublishedSession(2, 3)
    const firstReservation = await createHold(
      session.id,
      [session.seats[0]!.id, session.seats[1]!.id],
      Role.CUSTOMER,
    )
    await payReservation(firstReservation, PaymentStatus.APPROVED, Role.CUSTOMER)

    const secondReservation = await createHold(
      session.id,
      [session.seats[2]!.id],
      'SECOND_CUSTOMER',
    )
    await payReservation(
      secondReservation,
      PaymentStatus.APPROVED,
      'SECOND_CUSTOMER',
    )

    await createHold(session.id, [session.seats[3]!.id], 'SECOND_CUSTOMER')

    const metrics = await readMetrics(session.id)

    // 6 lugares: 3 vendidos em duas compras distintas, 1 em hold, 2 livres.
    expect(metrics).toEqual({
      capacity: 6,
      availableSeats: 2,
      heldSeats: 1,
      soldSeats: 3,
      occupancyPercentage: 50,
      simulatedRevenueCents: SESSION_PRICE_CENTS * 3,
    })
  })

  it('handles a session without seats without dividing by zero', async () => {
    const session = await createPublishedSession(2, 2)
    await prisma.seat.deleteMany({ where: { sessionId: session.id } })

    expect(await readMetrics(session.id)).toEqual({
      capacity: 0,
      availableSeats: 0,
      heldSeats: 0,
      soldSeats: 0,
      occupancyPercentage: 0,
      simulatedRevenueCents: 0,
    })
  })

  it('exposes metrics in the organizer list without leaking any personal data', async () => {
    const session = await createPublishedSession(2, 2)
    const reservationId = await createHold(session.id, [session.seats[0]!.id])
    await payReservation(reservationId, PaymentStatus.APPROVED)

    const list = await app.inject({
      method: 'GET',
      url: '/organizer/sessions',
      headers: authorization(tokenFor(Role.ORGANIZER)),
    })
    expect(list.statusCode).toBe(200)

    const listed = list
      .json<{ sessions: SessionResponse[] }>()
      .sessions.find(({ id }) => id === session.id)
    expect(listed?.metrics).toMatchObject({
      capacity: 4,
      soldSeats: 1,
      simulatedRevenueCents: SESSION_PRICE_CENTS,
    })

    const serialized = JSON.stringify(list.json())
    expect(serialized).not.toMatch(/@demo\.local/iu)
    expect(serialized).not.toMatch(
      /"(?:customer|customerId|email|owner|ownerId|passwordHash)"\s*:/iu,
    )
  })
})
