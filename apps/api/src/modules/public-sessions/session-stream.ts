import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  subscribeToSessionEvents,
  type SessionEventName,
} from '../../realtime/session-events.js'

const HEARTBEAT_INTERVAL_MILLISECONDS = 25_000
const CLIENT_RETRY_MILLISECONDS = 5_000

/**
 * Mantém os streams abertos de uma instância do Fastify para que `app.close()`
 * possa encerrá-los. Sem isso, o servidor HTTP ficaria preso esperando
 * conexões que, por natureza, nunca terminam sozinhas.
 */
export class SessionStreamRegistry {
  readonly #openStreams = new Set<() => void>()

  add(close: () => void) {
    this.#openStreams.add(close)
  }

  remove(close: () => void) {
    this.#openStreams.delete(close)
  }

  get size() {
    return this.#openStreams.size
  }

  closeAll() {
    for (const close of [...this.#openStreams]) {
      close()
    }
  }
}

/**
 * Publica o stream SSE de uma sessão. O corpo transporta apenas o nome do
 * evento e o `sessionId`; nunca ingresso, credencial, reserva ou identidade.
 */
export function startSessionEventStream(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  registry: SessionStreamRegistry,
) {
  reply.hijack()

  const { raw } = reply

  // `reply.hijack()` desliga a serialização do Fastify, então os headers já
  // definidos por hooks — CORS, entre outros — precisam ser copiados à mão.
  for (const [header, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) {
      raw.setHeader(header, value)
    }
  }

  raw.setHeader('Content-Type', 'text/event-stream')
  raw.setHeader('Cache-Control', 'no-store')
  raw.setHeader('Connection', 'keep-alive')
  // Evita que proxies com buffer segurem os eventos.
  raw.setHeader('X-Accel-Buffering', 'no')
  raw.flushHeaders()

  let isClosed = false

  function write(chunk: string) {
    if (isClosed || raw.writableEnded) {
      return
    }

    // An invalidation can be recovered by reconnect/polling. A slow client
    // must not grow the process write buffer without a bound.
    if (!raw.write(chunk)) close()
  }

  function send(event: SessionEventName) {
    write(`event: ${event}\ndata: ${JSON.stringify({ sessionId })}\n\n`)
  }

  const unsubscribe = subscribeToSessionEvents(sessionId, send)

  const heartbeat = setInterval(() => {
    write(': keep-alive\n\n')
  }, HEARTBEAT_INTERVAL_MILLISECONDS)

  // O heartbeat nunca deve manter o processo vivo sozinho.
  heartbeat.unref?.()

  function close() {
    if (isClosed) {
      return
    }

    isClosed = true
    clearInterval(heartbeat)
    unsubscribe()
    registry.remove(close)

    if (!raw.writableEnded) {
      raw.end()
    }
  }

  registry.add(close)
  request.raw.on('close', close)
  raw.on('close', close)
  raw.on('error', close)

  write(`retry: ${CLIENT_RETRY_MILLISECONDS}\n\n`)
  send('sync')
}
