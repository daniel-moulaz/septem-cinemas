import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError, cancelReservation, consumeGateTicket, createReservation,
  getPublicSessions, login, payReservation, revokeTicketShareLink,
  updateOrganizerSession,
} from '../src/api'

const fetchMock = vi.fn<typeof fetch>()
const ok = () => new Response(JSON.stringify({ sessions: [] }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('public read recovery', () => {
  it.each([408, 425, 429, 500, 502, 503, 504])('recovers from %s with backoff', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response('', { status })).mockResolvedValueOnce(ok())
    const request = getPublicSessions()
    await vi.advanceTimersByTimeAsync(1_499)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(request).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers from a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok())
    const request = getPublicSessions()
    await vi.runAllTimersAsync()
    await expect(request).resolves.toEqual([])
  })

  it('ends after five attempts and preserves the final API error', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'UNAVAILABLE', message: 'Indisponível' }), { status: 503 }))
    const result = getPublicSessions().catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ status: 503, code: 'UNAVAILABLE', message: 'Indisponível' })
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([400, 401, 403, 404, 409, 422])('does not retry %s', async (status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }))
    await expect(getPublicSessions()).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors Retry-After and declines to retry earlier than a long cooldown', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '4' } })).mockResolvedValueOnce(ok())
    const result = getPublicSessions()
    await vi.advanceTimersByTimeAsync(3_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await result
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }))
    await expect(getPublicSessions()).rejects.toMatchObject({ status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('aborts during backoff without leaving a timer', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'))
    const controller = new AbortController()
    const result = getPublicSessions('', controller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts an in-flight fetch and refuses a pre-aborted signal', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }))
    const controller = new AbortController()
    const result = getPublicSessions('', controller.signal).catch((error: unknown) => error)
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    await expect(getPublicSessions('', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds hanging reads with a timeout and recovers', async () => {
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    })).mockResolvedValueOnce(ok())
    const result = getPublicSessions()
    await vi.runAllTimersAsync()
    await expect(result).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

it.each([
  () => login('demo@example.com', 'password'),
  () => createReservation('token', 'session', ['seat']),
  () => payReservation('token', 'reservation', 'APPROVED'),
  () => cancelReservation('token', 'reservation'),
  () => consumeGateTicket('token', 'session', 'credential'),
  () => updateOrganizerSession('token', 'session', { roomName: 'Sala' }),
  () => revokeTicketShareLink('token', 'ticket'),
])('never retries a mutation automatically (%#)', async (operation) => {
  fetchMock.mockResolvedValue(new Response('{}', { status: 503 }))
  await expect(operation()).rejects.toMatchObject({ status: 503 })
  await vi.runAllTimersAsync()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
