import * as argon2 from 'argon2'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEMO_PASSWORD, DEMO_USERS } from '../prisma/seed-data.js'
import { buildApp } from '../src/app.js'
import {
  loginRetryAfterSeconds,
  loginThrottleKey,
  loginThrottleLimits,
  registerFailedLogin,
  resetLoginThrottle,
} from '../src/modules/auth/login-throttle.js'
import { Role } from '../src/generated/prisma/enums.js'
import { prisma } from '../src/lib/prisma.js'

interface LoginResponse {
  accessToken: string
  user: {
    id: string
    name: string
    email: string
    role: Role
  }
}

interface DecodedToken {
  header: { alg: string }
  payload: {
    aud: string
    exp: number
    iat: number
    iss: string
    role: Role
    sub: string
  }
}

const app = buildApp()
const loginsByEmail = new Map<string, LoginResponse>()

app.get(
  '/__tests/organizer',
  {
    preHandler: [app.authenticate, app.authorizeRoles(Role.ORGANIZER)],
  },
  async (request) => ({ role: request.authUser?.role }),
)

app.get(
  '/__tests/customer',
  {
    preHandler: [app.authenticate, app.authorizeRoles(Role.CUSTOMER)],
  },
  async (request) => ({ role: request.authUser?.role }),
)

app.get(
  '/__tests/gate',
  {
    preHandler: [app.authenticate, app.authorizeRoles(Role.GATE)],
  },
  async (request) => ({ role: request.authUser?.role }),
)

beforeAll(async () => {
  await app.ready()

  for (const demoUser of DEMO_USERS) {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: demoUser.email,
        password: DEMO_PASSWORD,
      },
    })

    expect(response.statusCode).toBe(200)
    loginsByEmail.set(demoUser.email, response.json<LoginResponse>())
  }
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

function getLogin(email: string) {
  const login = loginsByEmail.get(email)

  if (!login) {
    throw new Error(`Login de teste ausente para ${email}.`)
  }

  return login
}

function authorization(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` }
}

function tamperSignature(accessToken: string) {
  const tokenParts = accessToken.split('.')
  const signature = tokenParts[2]

  if (!signature) {
    throw new Error('JWT de teste inválido.')
  }

  tokenParts[2] = `${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`

  return tokenParts.join('.')
}

describe('seed de autenticação', () => {
  it('contains exactly the four demo users with the expected roles and hashes', async () => {
    const demoEmails = DEMO_USERS.map(({ email }) => email)
    const users = await prisma.user.findMany({
      where: { email: { in: demoEmails } },
      orderBy: { email: 'asc' },
    })

    expect(users).toHaveLength(4)
    expect(users.map(({ email, role }) => ({ email, role }))).toEqual(
      [...DEMO_USERS]
        .sort((first, second) => first.email.localeCompare(second.email))
        .map(({ email, role }) => ({ email, role })),
    )
    expect(new Set(users.map((user) => user.passwordHash)).size).toBe(4)

    for (const user of users) {
      expect(user.email).toBe(user.email.trim().toLowerCase())
      expect(user.passwordHash).not.toBe(DEMO_PASSWORD)
      expect(user.passwordHash).toMatch(/^\$argon2id\$/u)
      await expect(
        argon2.verify(user.passwordHash, DEMO_PASSWORD),
      ).resolves.toBe(true)
    }
  })
})

describe('POST /auth/login', () => {
  it('preserves client errors raised by Fastify without exposing internals', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=organizer%40demo.local',
    })

    expect(response.statusCode).toBe(415)
    expect(response.json()).toEqual({
      error: 'VALIDATION_ERROR',
      message: 'A requisição contém dados inválidos.',
    })
  })

  it('authenticates every demo role without exposing passwordHash', () => {
    for (const demoUser of DEMO_USERS) {
      const login = getLogin(demoUser.email)

      expect(login.accessToken).toEqual(expect.any(String))
      expect(login.user).toMatchObject({
        email: demoUser.email,
        role: demoUser.role,
      })
      expect(JSON.stringify(login)).not.toContain('passwordHash')
    }
  })

  it('normalizes email before lookup', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: '  ORGANIZER@DEMO.LOCAL  ',
        password: DEMO_PASSWORD,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<LoginResponse>().user.email).toBe(
      'organizer@demo.local',
    )
  })

  it('throttles an abusive origin before spending Argon2 on it', async () => {
    resetLoginThrottle()

    const statuses: number[] = []

    for (let attempt = 0; attempt < loginThrottleLimits.maxFailedAttempts; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'customer1@demo.local', password: 'senha-incorreta' },
      })
      statuses.push(response.statusCode)
    }

    expect(new Set(statuses)).toEqual(new Set([401]))

    const blocked = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'customer1@demo.local', password: 'senha-incorreta' },
    })

    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toEqual({
      error: 'TOO_MANY_LOGIN_ATTEMPTS',
      message: expect.any(String),
    })
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(
      loginThrottleLimits.cooldownMilliseconds / 1_000,
    )

    resetLoginThrottle()
  })

  it('never lets failed attempts lock a specific account out', async () => {
    resetLoginThrottle()

    // A chave do limite é a origem, não a conta. Falhar contra uma conta não
    // pode tornar outra — nem ela mesma — inacessível a partir de outro
    // cliente, porque a conta não participa da chave.
    const key = loginThrottleKey('203.0.113.10')
    const start = Date.now()

    for (let attempt = 0; attempt <= loginThrottleLimits.maxFailedAttempts; attempt += 1) {
      registerFailedLogin(key, start)
    }

    expect(loginRetryAfterSeconds(key, start + 1_000)).toBeGreaterThan(0)

    // Qualquer outra origem continua livre, para qualquer conta.
    expect(loginRetryAfterSeconds(loginThrottleKey('198.51.100.7'), start + 1_000)).toBeNull()

    resetLoginThrottle()

    // E, no fluxo real, a conta que sofreu as falhas continua entrando.
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'customer1@demo.local', password: DEMO_PASSWORD },
    })

    expect(login.statusCode).toBe(200)
  })

  it('releases the cooldown on its own', async () => {
    resetLoginThrottle()

    const key = loginThrottleKey('203.0.113.11')
    const start = Date.now()

    for (let attempt = 0; attempt < loginThrottleLimits.maxFailedAttempts; attempt += 1) {
      registerFailedLogin(key, start)
    }

    expect(loginRetryAfterSeconds(key, start + 1_000)).toBeGreaterThan(0)
    expect(
      loginRetryAfterSeconds(
        key,
        start + loginThrottleLimits.cooldownMilliseconds + 1,
      ),
    ).toBeNull()

    resetLoginThrottle()
  })

  it('clears the counter after a successful login', async () => {
    resetLoginThrottle()

    for (let attempt = 0; attempt < loginThrottleLimits.maxFailedAttempts - 1; attempt += 1) {
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'gate@demo.local', password: 'senha-incorreta' },
      })
    }

    const success = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'gate@demo.local', password: DEMO_PASSWORD },
    })

    expect(success.statusCode).toBe(200)

    for (let attempt = 0; attempt < loginThrottleLimits.maxFailedAttempts; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'gate@demo.local', password: 'senha-incorreta' },
      })
      expect(response.statusCode).toBe(401)
    }

    resetLoginThrottle()
  })

  it('returns the same generic error for a wrong password and unknown user', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'organizer@demo.local',
        password: 'senha-incorreta',
      },
    })
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'unknown@demo.local',
        password: 'senha-incorreta',
      },
    })

    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownUser.statusCode).toBe(401)
    expect(wrongPassword.json()).toEqual(unknownUser.json())
    expect(wrongPassword.json()).toEqual({
      error: 'INVALID_CREDENTIALS',
      message: 'E-mail ou senha inválidos.',
    })
  })

  it('rejects invalid input with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'not-an-email', password: '' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: 'VALIDATION_ERROR',
      message: 'Informe um e-mail e uma senha válidos.',
    })
  })

  it('issues an HS256 JWT for eight hours with explicit issuer and audience', () => {
    const login = getLogin('organizer@demo.local')
    const token = app.jwt.decode(login.accessToken, {
      complete: true,
    }) as DecodedToken | null

    expect(token).toBeTruthy()

    if (!token) {
      throw new Error('Não foi possível decodificar o JWT de teste.')
    }

    expect(token.header.alg).toBe('HS256')
    expect(token.payload).toMatchObject({
      sub: login.user.id,
      role: Role.ORGANIZER,
      iss: 'septem-cinemas-api',
      aud: 'septem-cinemas-web',
    })
    expect(Object.keys(token.payload).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'role',
      'sub',
    ])
    expect(token.payload).not.toHaveProperty('password')
    expect(token.payload).not.toHaveProperty('passwordHash')

    expect(token.payload.exp - token.payload.iat).toBe(8 * 60 * 60)
  })
})

describe('GET /auth/me and JWT validation', () => {
  it('returns the public user confirmed by the backend', async () => {
    const login = getLogin('customer1@demo.local')
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authorization(login.accessToken),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(login.user)
    expect(JSON.stringify(response.json())).not.toContain('passwordHash')
  })

  it('rejects a missing token with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: 'UNAUTHORIZED',
      message: 'Autenticação necessária.',
    })
  })

  it('rejects a tampered token with 401', async () => {
    const token = getLogin('organizer@demo.local').accessToken
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authorization(tamperSignature(token)),
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a validly signed token when its subject no longer identifies a user', async () => {
    const token = app.jwt.sign(
      { role: Role.ORGANIZER },
      { sub: '00000000-0000-4000-8000-000000000000' },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authorization(token),
    })

    expect(response.statusCode).toBe(401)
  })

  it('does not disguise a database failure as an invalid token', async () => {
    const findUser = vi
      .spyOn(prisma.user, 'findUnique')
      .mockRejectedValueOnce(new Error('Falha de banco simulada pelo teste.'))

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: authorization(
          getLogin('organizer@demo.local').accessToken,
        ),
      })

      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({
        error: 'INTERNAL_ERROR',
        message: 'Não foi possível concluir a solicitação.',
      })
    } finally {
      findUser.mockRestore()
    }
  })
})

describe('RBAC', () => {
  it('allows ORGANIZER on an organizer-only route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__tests/organizer',
      headers: authorization(
        getLogin('organizer@demo.local').accessToken,
      ),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ role: Role.ORGANIZER })
  })

  it.each(['customer1@demo.local', 'gate@demo.local'])(
    'denies %s on an organizer-only route',
    async (email) => {
      const response = await app.inject({
        method: 'GET',
        url: '/__tests/organizer',
        headers: authorization(getLogin(email).accessToken),
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({
        error: 'FORBIDDEN',
        message: 'Você não possui permissão para acessar este recurso.',
      })
    },
  )

  it('allows CUSTOMER on a customer-only route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__tests/customer',
      headers: authorization(
        getLogin('customer1@demo.local').accessToken,
      ),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ role: Role.CUSTOMER })
  })

  it('allows GATE on a gate-only route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__tests/gate',
      headers: authorization(getLogin('gate@demo.local').accessToken),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ role: Role.GATE })
  })

  it('uses the current database role instead of the role claim', async () => {
    const customer = getLogin('customer1@demo.local').user
    const tokenWithWrongRole = app.jwt.sign(
      { role: Role.ORGANIZER },
      { sub: customer.id },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/__tests/organizer',
      headers: authorization(tokenWithWrongRole),
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('CORS', () => {
  it('allows the configured web origin only', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    })
    const disallowed = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: {
        origin: 'https://untrusted.example',
        'access-control-request-method': 'POST',
      },
    })

    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    )
    expect(disallowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    )
    expect(disallowed.headers['access-control-allow-origin']).not.toBe(
      'https://untrusted.example',
    )
  })
})
