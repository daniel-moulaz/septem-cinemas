import { afterAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { HttpError } from '../src/http/error-response.js'
import { prisma } from '../src/lib/prisma.js'

const app = buildApp()
const secret = 'postgresql://private:password@internal/SecretTable Prisma SQL SELECT /srv/api.ts stack JWT_SECRET'
app.get('/test/internal', async () => { throw new Error(secret) })
app.get('/test/conflict', async () => { throw new HttpError(409, 'SEAT_UNAVAILABLE', 'Assento indisponível.') })
for (const status of [401, 403, 404, 409, 413]) {
  app.get(`/test/framework/${status}`, async () => { throw Object.assign(new Error(secret), { statusCode: status }) })
}
afterAll(async () => { await app.close(); await prisma.$disconnect() })

describe('public error contract', () => {
  it.each([
    ['/test/internal', 500, 'INTERNAL_ERROR'],
    ['/test/conflict', 409, 'SEAT_UNAVAILABLE'],
    ['/test/framework/401', 401, 'UNAUTHORIZED'],
    ['/test/framework/403', 403, 'FORBIDDEN'],
    ['/test/framework/404', 404, 'NOT_FOUND'],
    ['/test/framework/409', 409, 'CONFLICT'],
    ['/test/framework/413', 413, 'VALIDATION_ERROR'],
    ['/not-a-route/private-secret', 404, 'NOT_FOUND'],
    ['/sessions/not-a-uuid', 400, 'VALIDATION_ERROR'],
    ['/auth/me', 401, 'UNAUTHORIZED'],
  ])('%s returns a safe, consistent body', async (url, status, code) => {
    const response = await app.inject({ url: String(url) })
    expect(response.statusCode).toBe(status)
    expect(response.json()).toEqual({ error: code, message: expect.any(String) })
    expect(response.body).not.toMatch(/Prisma|SQL|postgres|SecretTable|private|password|stack|JWT_SECRET|\/srv/i)
  })

  it('hides malformed JSON parser details', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"password":"secret"' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'VALIDATION_ERROR', message: 'A requisição contém dados inválidos.' })
  })

  it('hides a database exception from a real route', async () => {
    const spy = vi.spyOn(prisma.session, 'findMany').mockRejectedValueOnce(new Error(secret))
    try {
      const response = await app.inject({ url: '/sessions' })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({ error: 'INTERNAL_ERROR', message: 'Não foi possível concluir a solicitação.' })
    } finally { spy.mockRestore() }
  })
})
