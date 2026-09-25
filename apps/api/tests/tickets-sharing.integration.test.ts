import { createHmac } from 'node:crypto'
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
  verifyTicketToken,
} from '../src/modules/tickets/ticket-crypto.js'

const TEST_SESSION_ADDRESS = 'Rua do Ingresso, 400 — teste M4'
const TICKET_SIGNING_SECRET = process.env.TICKET_SIGNING_SECRET!

interface TicketFixture {
  ticketId: string
  ownerId: string
  ownerEmail: string
  ownerName: string
  sessionId: string
  seatLabel: string
  issuedAt: Date
  startsAt: Date
}

interface TicketResponse {
  id: string
  status: TicketStatus
  manualCode: string
  issuedAt: string
  qrToken?: string
  session: {
    id: string
    movie: {
      title: string
      overview: string
      posterPath: string | null
      backdropPath: string | null
    }
    startsAt: string
    venueName: string
    roomName: string
    address: string
  }
  seat: {
    id: string
    label: string
    rowLabel: string
    number: number
  }
}

interface TicketListResponse {
  tickets: TicketResponse[]
}

interface ShareLinkResponse {
  url: string
  expiresAt: string
}

interface TicketTokenPayload {
  iss: string
  aud: string
  typ: string
  ver: number
  jti: string
  sid: string
  iat: number
  exp: number
}

const app = buildApp()
const accessTokens = new Map<Role | 'SECOND_CUSTOMER', string>()
const createdSessionIds = new Set<string>()
let organizerId: string | null = null
let customerOneId: string | null = null
let customerTwoId: string | null = null
let databaseSafetyConfirmed = false

function assertLocalTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl || process.env.NODE_ENV !== 'test') {
    throw new Error('Os testes de ingresso exigem NODE_ENV=test e DATABASE_URL local.')
  }

  const hostname = new URL(databaseUrl).hostname

  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Os testes de ingresso recusaram um PostgreSQL que não é local.')
  }

  databaseSafetyConfirmed = true
}

function requiredIds() {
  if (!organizerId || !customerOneId || !customerTwoId) {
    throw new Error('Os usuários dos testes de ingresso não foram inicializados.')
  }

  return { organizerId, customerOneId, customerTwoId }
}

function authorization(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` }
}

function tokenFor(role: Role | 'SECOND_CUSTOMER') {
  const token = accessTokens.get(role)

  if (!token) {
    throw new Error(`Token de teste ausente para ${role}.`)
  }

  return token
}

function futureDate(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1_000)
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

async function createTicketFixture(
  ownerId = requiredIds().customerOneId,
): Promise<TicketFixture> {
  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: { email: true, name: true },
  })
  const startsAt = futureDate(24)
  const session = await prisma.session.create({
    data: {
      organizerId: requiredIds().organizerId,
      status: SessionStatus.PUBLISHED,
      startsAt,
      venueName: 'Cine Bilhete',
      roomName: 'Sala QR',
      address: TEST_SESSION_ADDRESS,
      priceCents: 3_500,
      tmdbMovieId: 404,
      movieTitle: 'O Ingresso Assinado',
      movieOverview: 'Filme usado pelos testes de ingresso do M4.',
      moviePosterPath: '/ticket-poster.jpg',
      movieBackdropPath: '/ticket-backdrop.jpg',
      movieReleaseDate: new Date('2026-01-01T00:00:00.000Z'),
      movieRuntimeMinutes: 110,
      publishedAt: new Date(),
      seats: {
        create: { rowLabel: 'A', number: 7, label: 'A7' },
      },
    },
    include: { seats: true },
  })
  createdSessionIds.add(session.id)

  const reservation = await prisma.reservation.create({
    data: {
      customerId: ownerId,
      sessionId: session.id,
      status: ReservationStatus.PAID,
      expiresAt: futureDate(1),
      totalCents: session.priceCents,
      seats: {
        create: {
          seatId: session.seats[0]!.id,
          unitPriceCents: session.priceCents,
        },
      },
      payment: {
        create: {
          status: PaymentStatus.APPROVED,
          amountCents: session.priceCents,
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
      ownerId,
      status: TicketStatus.VALID,
      manualCode: generateManualCode(),
      issuedAt,
    },
  })

  return {
    ticketId: ticket.id,
    ownerId,
    ownerEmail: owner.email,
    ownerName: owner.name,
    sessionId: session.id,
    seatLabel: session.seats[0]!.label,
    issuedAt,
    startsAt,
  }
}

function shareTokenFromUrl(url: string) {
  const pathnameParts = new URL(url).pathname.split('/')
  const token = pathnameParts.at(-1)

  if (!token) {
    throw new Error('A URL compartilhada não contém token.')
  }

  return token
}

function forgeToken(
  token: string,
  options: {
    header?: Record<string, unknown>
    payload?: Partial<TicketTokenPayload>
  },
) {
  const [encodedHeader, encodedPayload] = token.split('.')

  if (!encodedHeader || !encodedPayload) {
    throw new Error('Token de teste inválido.')
  }

  const header = {
    ...(JSON.parse(
      Buffer.from(encodedHeader, 'base64url').toString('utf8'),
    ) as Record<string, unknown>),
    ...options.header,
  }
  const payload = {
    ...(JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as TicketTokenPayload),
    ...options.payload,
  }
  const forgedValue = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  const signature = createHmac('sha256', TICKET_SIGNING_SECRET)
    .update(forgedValue)
    .digest('base64url')

  return `${forgedValue}.${signature}`
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

  accessTokens.set(
    Role.ORGANIZER,
    app.jwt.sign({ role: Role.ORGANIZER }, { sub: organizer.id }),
  )
  accessTokens.set(
    Role.CUSTOMER,
    app.jwt.sign({ role: Role.CUSTOMER }, { sub: customerOne.id }),
  )
  accessTokens.set(
    'SECOND_CUSTOMER',
    app.jwt.sign({ role: Role.CUSTOMER }, { sub: customerTwo.id }),
  )
  accessTokens.set(
    Role.GATE,
    app.jwt.sign({ role: Role.GATE }, { sub: gate.id }),
  )

  await prisma.sharedTicketLink.deleteMany({
    where: { ticket: { session: { address: TEST_SESSION_ADDRESS } } },
  })
  await prisma.ticket.deleteMany({
    where: { session: { address: TEST_SESSION_ADDRESS } },
  })
  await prisma.payment.deleteMany({
    where: { reservation: { session: { address: TEST_SESSION_ADDRESS } } },
  })
  await prisma.reservation.deleteMany({
    where: { session: { address: TEST_SESSION_ADDRESS } },
  })
  await prisma.session.deleteMany({
    where: { address: TEST_SESSION_ADDRESS },
  })
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

describe('ticket cryptography', () => {
  it('generates friendly, unpredictable manual codes in the database format', () => {
    const codes = Array.from({ length: 200 }, generateManualCode)

    expect(new Set(codes).size).toBe(codes.length)

    for (const code of codes) {
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/u)
    }
  })

  it('signs only minimum non-PII claims and validates a fixed HS256 contract', () => {
    const fixture = {
      ticketId: '00000000-0000-4000-8000-000000000101',
      sessionId: '00000000-0000-4000-8000-000000000102',
      issuedAt: new Date('2026-08-18T12:00:00.000Z'),
      sessionStartsAt: new Date('2026-08-20T20:00:00.000Z'),
      movieRuntimeMinutes: 120,
      secret: TICKET_SIGNING_SECRET,
    }
    const token = signTicketToken(fixture)
    const [encodedHeader, encodedPayload] = token.split('.')
    const header = JSON.parse(
      Buffer.from(encodedHeader!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    const payload = JSON.parse(
      Buffer.from(encodedPayload!, 'base64url').toString('utf8'),
    ) as TicketTokenPayload

    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(payload).toMatchObject({
      iss: 'septem-cinemas-api',
      aud: 'septem-cinemas-gate',
      typ: 'ticket',
      ver: 1,
      jti: fixture.ticketId,
      sid: fixture.sessionId,
    })
    expect(Object.keys(payload).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'jti',
      'sid',
      'typ',
      'ver',
    ])
    expect(JSON.stringify(payload)).not.toMatch(/name|email|price|password/iu)
    expect(
      verifyTicketToken(token, {
        secret: TICKET_SIGNING_SECRET,
        now: fixture.issuedAt,
      }),
    ).toEqual(payload)

    const parts = token.split('.')
    parts[1] = `${parts[1]!.startsWith('a') ? 'b' : 'a'}${parts[1]!.slice(1)}`
    expect(() =>
      verifyTicketToken(parts.join('.'), {
        secret: TICKET_SIGNING_SECRET,
        now: fixture.issuedAt,
      }),
    ).toThrow('Token de ingresso inválido.')

    for (const forgedToken of [
      forgeToken(token, { header: { alg: 'HS512' } }),
      forgeToken(token, { payload: { iss: 'outro-emissor' } }),
      forgeToken(token, { payload: { aud: 'outra-audiencia' } }),
      forgeToken(token, { payload: { typ: 'auth' } }),
    ]) {
      expect(() =>
        verifyTicketToken(forgedToken, {
          secret: TICKET_SIGNING_SECRET,
          now: fixture.issuedAt,
        }),
      ).toThrow('Token de ingresso inválido.')
    }
  })
})

describe('customer tickets', () => {
  it('lists only the owner tickets and keeps the QR token out of the list', async () => {
    const ownTicket = await createTicketFixture()
    const otherTicket = await createTicketFixture(requiredIds().customerTwoId)
    const response = await app.inject({
      method: 'GET',
      url: '/me/tickets',
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<TicketListResponse>()
    expect(body.tickets.some(({ id }) => id === ownTicket.ticketId)).toBe(true)
    expect(body.tickets.some(({ id }) => id === otherTicket.ticketId)).toBe(false)
    expect(body.tickets.find(({ id }) => id === ownTicket.ticketId)).not.toHaveProperty(
      'qrToken',
    )
  })

  it('returns a dynamically signed QR only to the owner', async () => {
    const fixture = await createTicketFixture()
    const otherCustomer = await app.inject({
      method: 'GET',
      url: `/me/tickets/${fixture.ticketId}`,
      headers: authorization(tokenFor('SECOND_CUSTOMER')),
    })
    expect(otherCustomer.statusCode).toBe(404)
    expect(otherCustomer.json()).toMatchObject({ error: 'TICKET_NOT_FOUND' })

    const owner = await app.inject({
      method: 'GET',
      url: `/me/tickets/${fixture.ticketId}`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(owner.statusCode).toBe(200)
    expect(owner.headers['cache-control']).toBe('no-store')

    const ticket = owner.json<TicketResponse>()
    expect(ticket).toMatchObject({
      id: fixture.ticketId,
      status: TicketStatus.VALID,
      seat: { label: fixture.seatLabel },
      session: { id: fixture.sessionId },
    })
    expect(ticket.qrToken).toEqual(expect.any(String))

    const claims = verifyTicketToken(ticket.qrToken!, {
      secret: TICKET_SIGNING_SECRET,
    })
    expect(claims).toMatchObject({
      jti: fixture.ticketId,
      sid: fixture.sessionId,
    })
    expect(JSON.stringify(ticket)).not.toContain(fixture.ownerEmail)
    expect(JSON.stringify(ticket)).not.toContain(fixture.ownerName)
  })

  it.each([Role.ORGANIZER, Role.GATE])('rejects the %s role', async (role) => {
    const response = await app.inject({
      method: 'GET',
      url: '/me/tickets',
      headers: authorization(tokenFor(role)),
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('ticket sharing', () => {
  it('stores only SHA-256 and resolves a no-store public response without PII', async () => {
    const fixture = await createTicketFixture()
    const forbidden = await app.inject({
      method: 'POST',
      url: `/me/tickets/${fixture.ticketId}/share-link`,
      headers: authorization(tokenFor('SECOND_CUSTOMER')),
    })
    expect(forbidden.statusCode).toBe(404)

    const created = await app.inject({
      method: 'POST',
      url: `/me/tickets/${fixture.ticketId}/share-link`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    expect(created.statusCode).toBe(201)

    const share = created.json<ShareLinkResponse>()
    expect(created.headers['cache-control']).toBe('no-store')
    const rawToken = shareTokenFromUrl(share.url)
    const stored = await prisma.sharedTicketLink.findUniqueOrThrow({
      where: { ticketId: fixture.ticketId },
    })
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(stored.tokenHash).not.toContain(rawToken)
    expect(JSON.stringify(stored)).not.toContain(rawToken)

    const publicResponse = await app.inject({
      method: 'GET',
      url: `/shared/${rawToken}`,
    })
    expect(publicResponse.statusCode).toBe(200)
    expect(publicResponse.headers['cache-control']).toBe('no-store')
    expect(publicResponse.headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(publicResponse.json()).toMatchObject({
      id: fixture.ticketId,
      seat: { label: fixture.seatLabel },
      session: { id: fixture.sessionId },
    })
    expect(publicResponse.json()).toHaveProperty('qrToken')
    expect(publicResponse.body).not.toContain(fixture.ownerEmail)
    expect(publicResponse.body).not.toContain(fixture.ownerName)
  })

  it('rotates the single link and invalidates the previous token', async () => {
    const fixture = await createTicketFixture()
    const createLink = () =>
      app.inject({
        method: 'POST',
        url: `/me/tickets/${fixture.ticketId}/share-link`,
        headers: authorization(tokenFor(Role.CUSTOMER)),
      })
    const first = (await createLink()).json<ShareLinkResponse>()
    const second = (await createLink()).json<ShareLinkResponse>()
    const firstToken = shareTokenFromUrl(first.url)
    const secondToken = shareTokenFromUrl(second.url)

    expect(firstToken).not.toBe(secondToken)
    expect(
      await prisma.sharedTicketLink.count({
        where: { ticketId: fixture.ticketId },
      }),
    ).toBe(1)

    const [oldResponse, currentResponse] = await Promise.all([
      app.inject({ method: 'GET', url: `/shared/${firstToken}` }),
      app.inject({ method: 'GET', url: `/shared/${secondToken}` }),
    ])
    expect(oldResponse.statusCode).toBe(404)
    expect(oldResponse.headers['cache-control']).toBe('no-store')
    expect(currentResponse.statusCode).toBe(200)
  })

  it('revokes a link idempotently and rejects it publicly', async () => {
    const fixture = await createTicketFixture()
    const created = await app.inject({
      method: 'POST',
      url: `/me/tickets/${fixture.ticketId}/share-link`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    const rawToken = shareTokenFromUrl(
      created.json<ShareLinkResponse>().url,
    )

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revoked = await app.inject({
        method: 'DELETE',
        url: `/me/tickets/${fixture.ticketId}/share-link`,
        headers: authorization(tokenFor(Role.CUSTOMER)),
      })
      expect(revoked.statusCode).toBe(204)
    }

    const publicResponse = await app.inject({
      method: 'GET',
      url: `/shared/${rawToken}`,
    })
    expect(publicResponse.statusCode).toBe(410)
    expect(publicResponse.headers['cache-control']).toBe('no-store')
    expect(publicResponse.json()).toMatchObject({ error: 'SHARED_LINK_REVOKED' })
  })

  it('rejects an expired link with a no-store response', async () => {
    const fixture = await createTicketFixture()
    const created = await app.inject({
      method: 'POST',
      url: `/me/tickets/${fixture.ticketId}/share-link`,
      headers: authorization(tokenFor(Role.CUSTOMER)),
    })
    const rawToken = shareTokenFromUrl(
      created.json<ShareLinkResponse>().url,
    )

    await prisma.sharedTicketLink.update({
      where: { ticketId: fixture.ticketId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })

    const publicResponse = await app.inject({
      method: 'GET',
      url: `/shared/${rawToken}`,
    })
    expect(publicResponse.statusCode).toBe(410)
    expect(publicResponse.headers['cache-control']).toBe('no-store')
    expect(publicResponse.json()).toMatchObject({ error: 'SHARED_LINK_EXPIRED' })
  })
})
