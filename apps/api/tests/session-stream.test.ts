import { EventEmitter } from 'node:events'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { expect, it, vi } from 'vitest'
import { SessionStreamRegistry, startSessionEventStream } from '../src/modules/public-sessions/session-stream.js'
import { publishSeatsChanged } from '../src/realtime/session-events.js'

it('unsubscribes and stops heartbeats when a slow client fills the write buffer', () => {
  vi.useFakeTimers()
  try {
    const raw = Object.assign(new EventEmitter(), {
      writableEnded: false,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn().mockReturnValue(false),
      end: vi.fn(),
    })
    const registry = new SessionStreamRegistry()
    startSessionEventStream(
      { raw: new EventEmitter() } as FastifyRequest,
      { raw, hijack: vi.fn(), getHeaders: () => ({}) } as unknown as FastifyReply,
      'slow-client', registry,
    )
    expect(raw.end).toHaveBeenCalledOnce()
    expect(registry.size).toBe(0)
    publishSeatsChanged('slow-client')
    vi.advanceTimersByTime(50_000)
    expect(raw.write).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
