import type { FastifyRequest } from 'fastify'

export const loggerOptions = {
  redact: ['req.headers.authorization', 'req.body.password', 'req.body.credential'],
  serializers: {
    req(request: FastifyRequest) {
      // Bearer share links are credentials even though they are in a URL.
      // Queries aren't needed to correlate requests and may contain user data.
      const path = request.url.split('?')[0] ?? ''
      return {
        method: request.method,
        url: path.startsWith('/shared/') ? '/shared/[REDACTED]' : path,
        remoteAddress: request.ip,
      }
    },
  },
}
