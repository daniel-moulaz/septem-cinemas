import { randomUUID } from 'node:crypto'
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
  scheduleSeatsInvalidation,
  sessionSubscriberCount,
} from '../src/realtime/session-events.js'

const TEST_SESSION_ADDRESS = 'Rua do Tempo Real, 202 — teste P0.2'
const SESSION_PRICE_CENTS = 3_100
const FAILURE_TRIGGER = 'P02_fail_reservation_seat_release'
const FAILURE_FUNCTION = 'P02_fail_reservation_seat_release_function'
const FAILURE_TABLE = 'P02RealtimeFailure'

/** Janela de proteção de stream; nunca usada para sincronizar lógica. */
const EVENT_TIMEOUT_MILLISECONDS = 5_000
/** Janela usada apenas para provar a AUSÊNCIA de um evento. */
const SILENCE_WINDOW_MILLISECONDS = 750

interface TestSession {
  id: string
  seats: Array<{ id: string; label: string }>
}

interface SeatMapResponse {
  sessionId: string
  seats: Array<{
    id: string
    label: string
    status: 'AVAILABLE' | 'HELD' | 'SOLD'
  }>
}

interface HoldResponse {
  id: string
}

interface SseEvent {
  event: string
  data: string
}

type CustomerIdentity = 'CUSTOMER' | 'SECOND_CUSTOMER'
type AuthIdentity = Role | 'SECOND_CUSTOMER'

const app = buildApp()
const accessTokens = new Map<AuthIdentity, string>()
const createdSessionIds = new Set<string>()
const openClients = new Set<{ close: () => Promise<void> }>()
let baseUrl = ''
let databaseSafetyConfirmed = false
let organizerId: string | null = null

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error(
      'Os testes de tempo real exigem NODE_ENV=test e DATABASE_URL local.',
    )
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Os testes de tempo real recusaram um PostgreSQL não local.')
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

/**
 * Cliente SSE mínimo sobre `fetch`. Ele espera por eventos reais em vez de
 * dormir por um intervalo arbitrário: os timeouts existem apenas para que um
 * stream travado falhe o teste em vez de pendurá-lo.
 */
async function openSessionStream(sessionId: string) {
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}/sessions/${sessionId}/events`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })

  if (!response.body) {
    throw new Error('O stream SSE não retornou corpo.')
  }

  const received: SseEvent[] = []
  const listeners = new Set<() => void>()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })

        let separator = buffer.indexOf('\n\n')

        while (separator !== -1) {
          const block = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)

          const lines = block.split('\n')
          const eventLine = lines.find((line) => line.startsWith('event: '))
          const dataLine = lines.find((line) => line.startsWith('data: '))

          if (eventLine) {
            received.push({
              event: eventLine.slice('event: '.length),
              data: dataLine?.slice('data: '.length) ?? '',
            })

            for (const notify of [...listeners]) {
              notify()
            }
          }

          separator = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // Encerramento do stream por abort é esperado.
    }
  })()

  const client = {
    response,
    received,
    count() {
      return received.length
    },
    waitForEvent(
      name: string,
      fromIndex = 0,
      timeoutMilliseconds = EVENT_TIMEOUT_MILLISECONDS,
    ) {
      return new Promise<SseEvent>((resolve, reject) => {
        function cleanup() {
          clearTimeout(timer)
          listeners.delete(check)
        }

        function check() {
          const found = received
            .slice(fromIndex)
            .find((event) => event.event === name)

          if (found) {
            cleanup()
            resolve(found)
          }
        }

        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`O evento "${name}" não chegou pelo stream.`))
        }, timeoutMilliseconds)

        listeners.add(check)
        check()
      })
    },
    async expectSilence(fromIndex: number) {
      await new Promise((resolve) =>
        setTimeout(resolve, SILENCE_WINDOW_MILLISECONDS),
      )

      return received.slice(fromIndex)
    },
    async close() {
      controller.abort()
      await pump
      openClients.delete(client)
    },
  }

  openClients.add(client)

  return client
}

async function createTestSession(seatCount = 3): Promise<TestSession> {
  if (!organizerId) {
    throw new Error('O organizador dos testes de tempo real não foi carregado.')
  }

  const session = await prisma.session.create({
    data: {
      organizerId,
      status: SessionStatus.PUBLISHED,
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      venueName: 'Cine Tempo Real',
      roomName: 'Sala Sinal',
      address: TEST_SESSION_ADDRESS,
      priceCents: SESSION_PRICE_CENTS,
      tmdbMovieId: 902,
      movieTitle: 'O Mapa Vivo',
      movieOverview: 'Sessão criada exclusivamente pela suíte P0.2.',
      moviePosterPath: '/p02-poster.jpg',
      movieBackdropPath: null,
      movieReleaseDate: new Date('2026-03-01T00:00:00.000Z'),
      movieRuntimeMinutes: 101,
      publishedAt: new Date(),
      seats: {
        create: Array.from({ length: seatCount }, (_, index) => ({
          rowLabel: 'C',
          number: index + 1,
          label: `C${index + 1}`,
        })),
      },
    },
    include: {
      seats: { select: { id: true, label: true }, orderBy: { number: 'asc' } },
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

async function createHold(
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
  outcome: PaymentStatus,
  identity: CustomerIdentity = Role.CUSTOMER,
) {
  return app.inject({
    method: 'POST',
    url: `/reservations/${reservationId}/payment`,
    headers: authorization(tokenFor(identity)),
    payload: { outcome },
  })
}

async function fetchSeatMap(sessionId: string) {
  const response = await fetch(`${baseUrl}/sessions/${sessionId}/seats`)
  expect(response.status).toBe(200)
  return (await response.json()) as SeatMapResponse
}

function seatStatus(map: SeatMapResponse, seatId: string) {
  return map.seats.find((seat) => seat.id === seatId)?.status
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
}

async function installFailureTrigger(reservationSeatId: string) {
  await removeFailureTrigger()
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${FAILURE_TABLE}" ("reservationSeatId" UUID PRIMARY KEY)
  `)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${FAILURE_TABLE}" ("reservationSeatId") VALUES ($1::uuid)`,
    reservationSeatId,
  )
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${FAILURE_FUNCTION}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW."releasedAt" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "${FAILURE_TABLE}" WHERE "reservationSeatId" = NEW."id"
      ) THEN
        RAISE EXCEPTION 'controlled P0.2 realtime release failure';
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

beforeAll(async () => {
  assertLocalTestDatabase()
  await app.listen({ host: '127.0.0.1', port: 0 })

  const address = app.server.address()

  if (!address || typeof address === 'string') {
    throw new Error('O servidor de teste não expôs uma porta efêmera.')
  }

  baseUrl = `http://127.0.0.1:${address.port}`

  const [organizer, customerOne, customerTwo] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: 'organizer@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'customer1@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'customer2@demo.local' } }),
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
    await Promise.allSettled([...openClients].map((client) => client.close()))
    await removeFailureTrigger()
    await removeCreatedSessions()
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
})

describe('GET /sessions/:id/events stream contract', () => {
  it('opens the stream with SSE headers and an initial sync carrying no sensitive data', async () => {
    const session = await createTestSession()
    const client = await openSessionStream(session.id)

    try {
      expect(client.response.status).toBe(200)
      expect(client.response.headers.get('content-type')).toContain(
        'text/event-stream',
      )
      expect(client.response.headers.get('cache-control')).toBe('no-store')
      // `reply.hijack()` desliga os hooks de onSend, então os cabeçalhos de
      // segurança precisam sobreviver por terem sido definidos em onRequest.
      expect(client.response.headers.get('x-content-type-options')).toBe(
        'nosniff',
      )
      expect(client.response.headers.get('referrer-policy')).toBe('no-referrer')

      const sync = await client.waitForEvent('sync')
      expect(JSON.parse(sync.data)).toEqual({ sessionId: session.id })
    } finally {
      await client.close()
    }
  })

  it('rejects an invalid, unknown, or unpublished session without opening a stream', async () => {
    const draft = await prisma.session.create({
      data: {
        organizerId: organizerId!,
        status: SessionStatus.DRAFT,
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        venueName: 'Cine Tempo Real',
        roomName: 'Sala Rascunho',
        address: TEST_SESSION_ADDRESS,
        priceCents: SESSION_PRICE_CENTS,
        tmdbMovieId: 903,
        movieTitle: 'Rascunho Invisível',
        movieOverview: 'Sessão não publicada da suíte P0.2.',
        moviePosterPath: null,
        movieBackdropPath: null,
        movieReleaseDate: null,
        movieRuntimeMinutes: null,
      },
    })
    createdSessionIds.add(draft.id)

    const invalid = await fetch(`${baseUrl}/sessions/not-a-uuid/events`)
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: 'VALIDATION_ERROR' })

    const unknown = await fetch(`${baseUrl}/sessions/${randomUUID()}/events`)
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).toContain('application/json')
    expect(await unknown.json()).toMatchObject({ error: 'SESSION_NOT_FOUND' })

    const unpublished = await fetch(`${baseUrl}/sessions/${draft.id}/events`)
    expect(unpublished.status).toBe(404)
    expect(await unpublished.json()).toMatchObject({
      error: 'SESSION_NOT_FOUND',
    })
  })

  it('removes the subscriber when the client disconnects', async () => {
    const session = await createTestSession()
    const client = await openSessionStream(session.id)
    await client.waitForEvent('sync')

    expect(sessionSubscriberCount(session.id)).toBe(1)

    await client.close()
    // O servidor precisa observar o fechamento do socket antes de limpar.
    const deadline = Date.now() + EVENT_TIMEOUT_MILLISECONDS
    while (sessionSubscriberCount(session.id) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(sessionSubscriberCount(session.id)).toBe(0)
  })

  it('does not block app.close() while a stream is still open', async () => {
    const secondaryApp = buildApp()
    await secondaryApp.listen({ host: '127.0.0.1', port: 0 })
    const address = secondaryApp.server.address()

    if (!address || typeof address === 'string') {
      throw new Error('O servidor auxiliar não expôs uma porta efêmera.')
    }

    const session = await createTestSession()
    const controller = new AbortController()
    const response = await fetch(
      `http://127.0.0.1:${address.port}/sessions/${session.id}/events`,
      { signal: controller.signal, headers: { accept: 'text/event-stream' } },
    )
    expect(response.status).toBe(200)

    try {
      await secondaryApp.close()
    } finally {
      controller.abort()
      await response.body?.cancel().catch(() => undefined)
    }

    expect(sessionSubscriberCount(session.id)).toBe(0)
  }, 20_000)
})

describe('seat availability invalidation', () => {
  it('notifies a watching client when another customer holds a seat, and the snapshot confirms it', async () => {
    const session = await createTestSession()
    const seat = session.seats[0]!
    const watcher = await openSessionStream(session.id)

    try {
      await watcher.waitForEvent('sync')
      const cursor = watcher.count()

      await createHold(session.id, [seat.id], Role.CUSTOMER)

      const event = await watcher.waitForEvent('seats-changed', cursor)
      expect(JSON.parse(event.data)).toEqual({ sessionId: session.id })

      const map = await fetchSeatMap(session.id)
      expect(seatStatus(map, seat.id)).toBe('HELD')
    } finally {
      await watcher.close()
    }
  })

  it('signals the HELD to SOLD transition after an approved payment', async () => {
    const session = await createTestSession()
    const seat = session.seats[0]!
    const hold = await createHold(session.id, [seat.id])
    const watcher = await openSessionStream(session.id)

    try {
      await watcher.waitForEvent('sync')
      const cursor = watcher.count()

      const payment = await payReservation(hold.id, PaymentStatus.APPROVED)
      expect(payment.statusCode).toBe(200)

      await watcher.waitForEvent('seats-changed', cursor)

      const map = await fetchSeatMap(session.id)
      expect(seatStatus(map, seat.id)).toBe('SOLD')
    } finally {
      await watcher.close()
    }
  })

  it('signals the release caused by a declined payment', async () => {
    const session = await createTestSession()
    const seat = session.seats[0]!
    const hold = await createHold(session.id, [seat.id])
    const watcher = await openSessionStream(session.id)

    try {
      await watcher.waitForEvent('sync')
      const cursor = watcher.count()

      const payment = await payReservation(hold.id, PaymentStatus.DECLINED)
      expect(payment.statusCode).toBe(200)

      await watcher.waitForEvent('seats-changed', cursor)

      const map = await fetchSeatMap(session.id)
      expect(seatStatus(map, seat.id)).toBe('AVAILABLE')
    } finally {
      await watcher.close()
    }
  })

  it('signals the release caused by an individual ticket cancellation', async () => {
    const session = await createTestSession()
    const [first, second] = session.seats as [
      { id: string; label: string },
      { id: string; label: string },
    ]
    const hold = await createHold(session.id, [first.id, second.id])
    const payment = await payReservation(hold.id, PaymentStatus.APPROVED)
    expect(payment.statusCode).toBe(200)
    const { tickets } = payment.json<{ tickets: Array<{ id: string }> }>()
    const ticketToCancel = await prisma.ticket.findFirstOrThrow({
      where: {
        id: { in: tickets.map(({ id }) => id) },
        reservationSeat: { seatId: first.id },
      },
      select: { id: true },
    })

    const watcher = await openSessionStream(session.id)

    try {
      await watcher.waitForEvent('sync')
      const cursor = watcher.count()

      const cancellation = await app.inject({
        method: 'POST',
        url: `/me/tickets/${ticketToCancel.id}/cancel`,
        headers: authorization(tokenFor(Role.CUSTOMER)),
      })
      expect(cancellation.statusCode).toBe(200)

      await watcher.waitForEvent('seats-changed', cursor)

      const map = await fetchSeatMap(session.id)
      expect(seatStatus(map, first.id)).toBe('AVAILABLE')
      expect(seatStatus(map, second.id)).toBe('SOLD')
    } finally {
      await watcher.close()
    }
  })

  it('signals the release caused by cancelling the whole purchase', async () => {
    const session = await createTestSession()
    const [first, second] = session.seats as [
      { id: string; label: string },
      { id: string; label: string },
    ]
    const hold = await createHold(session.id, [first.id, second.id])
    expect((await payReservation(hold.id, PaymentStatus.APPROVED)).statusCode).toBe(
      200,
    )

    const watcher = await openSessionStream(session.id)

    try {
      await watcher.waitForEvent('sync')
      const cursor = watcher.count()

      const cancellation = await app.inject({
        method: 'POST',
        url: `/reservations/${hold.id}/cancel`,
        headers: authorization(tokenFor(Role.CUSTOMER)),
      })
      expect(cancellation.statusCode).toBe(200)

      await watcher.waitForEvent('seats-changed', cursor)

      const map = await fetchSeatMap(session.id)
      expect(seatStatus(map, first.id)).toBe('AVAILABLE')
      expect(seatStatus(map, second.id)).toBe('AVAILABLE')
    } finally {
      await watcher.close()
    }
  })

  it('signals session-changed after a safe structural edit, and nothing after a rollback', async () => {
    const session = await createTestSession()
    const watcher = await openSessionStream(session.id)

    try {
      await watcher.waitForEvent('sync')
      const editCursor = watcher.count()

      const edit = await app.inject({
        method: 'PATCH',
        url: `/organizer/sessions/${session.id}`,
        headers: authorization(tokenFor(Role.ORGANIZER)),
        payload: { priceCents: 4_900 },
      })
      expect(edit.statusCode).toBe(200)

      const event = await watcher.waitForEvent('session-changed', editCursor)
      expect(JSON.parse(event.data)).toEqual({ sessionId: session.id })

      // Um hold ativo torna a próxima edição insegura de forma determinística.
      const holdCursor = watcher.count()
      await createHold(session.id, [session.seats[0]!.id], Role.CUSTOMER)
      await watcher.waitForEvent('seats-changed', holdCursor)

      const blockedCursor = watcher.count()
      const blocked = await app.inject({
        method: 'PATCH',
        url: `/organizer/sessions/${session.id}`,
        headers: authorization(tokenFor(Role.ORGANIZER)),
        payload: { priceCents: 1 },
      })
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json()).toMatchObject({ error: 'SESSION_NOT_EDITABLE' })

      // Nada foi alterado, então nada pode ter sido publicado.
      const silence = await watcher.expectSilence(blockedCursor)
      expect(silence).toEqual([])
      expect(
        await prisma.session.findUniqueOrThrow({
          where: { id: session.id },
          select: { priceCents: true },
        }),
      ).toEqual({ priceCents: 4_900 })
    } finally {
      await watcher.close()
    }
  })

  it('never leaks an event from one session into another session stream', async () => {
    const [watched, other] = await Promise.all([
      createTestSession(),
      createTestSession(),
    ])
    const watcher = await openSessionStream(watched.id)

    try {
      await watcher.waitForEvent('sync')
      const cursor = watcher.count()

      await createHold(other.id, [other.seats[0]!.id], Role.CUSTOMER)

      const silence = await watcher.expectSilence(cursor)
      expect(silence).toEqual([])

      // A mesma conexão continua viva e reagindo à própria sessão.
      await createHold(watched.id, [watched.seats[0]!.id], 'SECOND_CUSTOMER')
      await watcher.waitForEvent('seats-changed', cursor)
    } finally {
      await watcher.close()
    }
  })

  it('publishes nothing when the transaction rolls back', async () => {
    const session = await createTestSession()
    const seat = session.seats[0]!
    const hold = await createHold(session.id, [seat.id])
    expect((await payReservation(hold.id, PaymentStatus.APPROVED)).statusCode).toBe(
      200,
    )

    const allocation = await prisma.reservationSeat.findFirstOrThrow({
      where: { reservationId: hold.id },
      select: { id: true },
    })
    await installFailureTrigger(allocation.id)

    const watcher = await openSessionStream(session.id)

    try {
      await watcher.waitForEvent('sync')
      const cursor = watcher.count()

      const cancellation = await app.inject({
        method: 'POST',
        url: `/reservations/${hold.id}/cancel`,
        headers: authorization(tokenFor(Role.CUSTOMER)),
      })
      expect(cancellation.statusCode).toBe(500)

      const silence = await watcher.expectSilence(cursor)
      expect(silence).toEqual([])

      // O rollback preservou o estado, e o snapshot continua coerente.
      expect(
        await prisma.reservation.findUniqueOrThrow({
          where: { id: hold.id },
          select: { status: true },
        }),
      ).toEqual({ status: ReservationStatus.PAID })
      expect(
        await prisma.ticket.count({
          where: { sessionId: session.id, status: TicketStatus.VALID },
        }),
      ).toBe(1)

      const map = await fetchSeatMap(session.id)
      expect(seatStatus(map, seat.id)).toBe('SOLD')
    } finally {
      await removeFailureTrigger()
      await watcher.close()
    }
  })
})

describe('recovery, expiration, and polling fallback', () => {
  it('recovers the correct state through sync and the snapshot after a reconnect', async () => {
    const session = await createTestSession()
    const seat = session.seats[0]!
    const firstConnection = await openSessionStream(session.id)
    await firstConnection.waitForEvent('sync')
    await firstConnection.close()

    // A mudança acontece enquanto nenhum stream está conectado: o evento
    // correspondente se perde, exatamente como numa queda de conexão.
    await createHold(session.id, [seat.id], Role.CUSTOMER)

    const reconnected = await openSessionStream(session.id)

    try {
      const sync = await reconnected.waitForEvent('sync')
      expect(JSON.parse(sync.data)).toEqual({ sessionId: session.id })

      const map = await fetchSeatMap(session.id)
      expect(seatStatus(map, seat.id)).toBe('HELD')
    } finally {
      await reconnected.close()
    }
  })

  it('keeps the snapshot authoritative for hold expiration and can wake clients for it', async () => {
    const session = await createTestSession()
    const seat = session.seats[0]!
    const hold = await createHold(session.id, [seat.id])

    expect(seatStatus(await fetchSeatMap(session.id), seat.id)).toBe('HELD')

    // A expiração é decidida por expiresAt e pelo relógio do banco, nunca por
    // estado em memória: envelhecer a linha basta para o snapshot mudar.
    await prisma.reservation.update({
      where: { id: hold.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    })

    expect(seatStatus(await fetchSeatMap(session.id), seat.id)).toBe('AVAILABLE')

    // O agendamento é apenas um atalho de latência: ele acorda o cliente, que
    // em seguida reconsulta o snapshot autoritativo.
    const watcher = await openSessionStream(session.id)

    try {
      await watcher.waitForEvent('sync')
      const cursor = watcher.count()

      scheduleSeatsInvalidation(
        `test-${hold.id}`,
        session.id,
        new Date(Date.now() + 50),
      )

      await watcher.waitForEvent('seats-changed', cursor)
      expect(seatStatus(await fetchSeatMap(session.id), seat.id)).toBe(
        'AVAILABLE',
      )
    } finally {
      await watcher.close()
    }
  })

  it('keeps the snapshot endpoint usable as a polling fallback without any stream', async () => {
    const session = await createTestSession()
    const seat = session.seats[0]!

    expect(sessionSubscriberCount(session.id)).toBe(0)
    expect(seatStatus(await fetchSeatMap(session.id), seat.id)).toBe('AVAILABLE')

    await createHold(session.id, [seat.id], Role.CUSTOMER)

    // Sem nenhum assinante, o polling continua sendo suficiente para observar
    // a mudança: o SSE nunca é requisito de correção.
    expect(sessionSubscriberCount(session.id)).toBe(0)
    expect(seatStatus(await fetchSeatMap(session.id), seat.id)).toBe('HELD')
  })
})
