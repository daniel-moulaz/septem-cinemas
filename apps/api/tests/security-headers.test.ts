import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

const appsToClose: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  await Promise.all(appsToClose.splice(0).map((app) => app.close()))
})

describe('cabeçalhos de segurança', () => {
  it('restricts CORS to the configured frontend and exposes Retry-After', async () => {
    const app = buildApp()
    appsToClose.push(app)
    const response = await app.inject({ url: '/health', headers: { origin: 'https://untrusted.example' } })
    expect(response.headers['access-control-allow-origin']).not.toBe('https://untrusted.example')
    expect(response.headers['access-control-expose-headers']).toContain('Retry-After')
  })

  it('sets HSTS only when HTTPS is established through a trusted proxy', async () => {
    const app = buildApp({ trustProxy: true })
    appsToClose.push(app)
    const secure = await app.inject({ url: '/health', headers: { 'x-forwarded-proto': 'https' } })
    const local = await app.inject({ url: '/health' })
    expect(secure.headers['strict-transport-security']).toBe('max-age=31536000')
    expect(local.headers['strict-transport-security']).toBeUndefined()
  })

  it('serves Swagger UI with its generated CSP and working static assets', async () => {
    const app = buildApp()
    appsToClose.push(app)
    const page = await app.inject({ url: '/docs/' })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-security-policy']).toContain('script-src')
    const script = await app.inject({ url: '/docs/static/swagger-ui-bundle.js' })
    expect(script.statusCode).toBe(200)
  })
  it('applies the baseline headers to success, error and not-found responses', async () => {
    const app = buildApp()
    appsToClose.push(app)

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/sessions/nao-e-uuid' }),
      app.inject({ method: 'GET', url: '/rota-inexistente' }),
      app.inject({ method: 'GET', url: '/organizer/sessions' }),
    ])

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      200, 400, 404, 401,
    ])

    for (const response of responses) {
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['referrer-policy']).toBe('no-referrer')
      expect(response.headers['x-frame-options']).toBe('DENY')
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['permissions-policy']).toContain('camera=()')
    }
  })
})
