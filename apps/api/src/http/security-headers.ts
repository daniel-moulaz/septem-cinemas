import type { FastifyInstance } from 'fastify'

/**
 * Cabeçalhos de segurança aplicados a toda resposta da API.
 *
 * O hook é `onRequest`, e não `onSend`, de propósito: o stream SSE de
 * `GET /sessions/:id/events` chama `reply.hijack()` e copia manualmente
 * `reply.getHeaders()`. Hooks de `onSend` nunca rodam para respostas
 * sequestradas, então definir os cabeçalhos ali deixaria justamente o endpoint
 * de longa duração descoberto.
 *
 * O Swagger define sua própria CSP compatível com os assets de `/docs`.
 * O conjunto global preserva o consumo autorizado por CORS pelo frontend,
 * que roda em outro site (Vercel).
 */
export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    if (request.protocol === 'https') {
      reply.header('strict-transport-security', 'max-age=31536000')
    }
    // Impede que um corpo JSON seja interpretado como HTML por sniffing.
    reply.header('x-content-type-options', 'nosniff')
    // Nenhuma URL desta API — que carrega ids de ingresso e de sessão — deve
    // vazar como referrer para terceiros.
    reply.header('referrer-policy', 'no-referrer')
    // A API não tem caso de uso legítimo dentro de um frame.
    reply.header('x-frame-options', 'DENY')
  })
}
