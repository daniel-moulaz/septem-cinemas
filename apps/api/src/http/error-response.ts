import type { FastifyInstance, FastifyReply } from 'fastify'

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'TOO_MANY_LOGIN_ATTEMPTS'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TMDB_NOT_CONFIGURED'
  | 'TMDB_TIMEOUT'
  | 'TMDB_UPSTREAM_ERROR'
  | 'MOVIE_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_EDITABLE'
  | 'SESSION_LAYOUT_NOT_EDITABLE'
  | 'SESSION_ALREADY_PUBLISHED'
  | 'SESSION_NOT_PUBLISHABLE'
  | 'SEAT_UNAVAILABLE'
  | 'RESERVATION_EXPIRED'
  | 'SESSION_NOT_AVAILABLE'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_ALREADY_CANCELLED'
  | 'RESERVATION_NOT_CANCELLABLE'
  | 'RESERVATION_SESSION_STARTED'
  | 'RESERVATION_HAS_USED_TICKET'
  | 'PAYMENT_ALREADY_PROCESSED'
  | 'PAYMENT_NOT_AVAILABLE'
  | 'TICKET_NOT_FOUND'
  | 'TICKET_NOT_SHAREABLE'
  | 'TICKET_NOT_CANCELLABLE'
  | 'TICKET_SESSION_STARTED'
  | 'SHARED_TICKET_NOT_FOUND'
  | 'SHARED_LINK_EXPIRED'
  | 'SHARED_LINK_REVOKED'
  | 'INTERNAL_ERROR'

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  error: ErrorCode,
  message: string,
) {
  return reply.code(statusCode).send({ error, message })
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, 404, 'NOT_FOUND', 'Recurso não encontrado.'),
  )
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.statusCode >= 500) {
        request.log.warn(
          { err: error },
          'Falha controlada ao processar a requisição',
        )
      }

      return sendError(reply, error.statusCode, error.code, error.message)
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      const { statusCode } = error

      const publicErrors: Partial<Record<number, [ErrorCode, string]>> = {
        401: ['UNAUTHORIZED', 'Autenticação necessária.'],
        403: ['FORBIDDEN', 'Você não possui permissão para acessar este recurso.'],
        409: ['CONFLICT', 'A solicitação conflita com o estado atual do recurso.'],
      }
      const publicError = publicErrors[statusCode]
      if (publicError) return sendError(reply, statusCode, ...publicError)

      if (statusCode === 404) {
        return sendError(
          reply,
          404,
          'NOT_FOUND',
          'Recurso não encontrado.',
        )
      }

      return sendError(
        reply,
        statusCode,
        'VALIDATION_ERROR',
        'A requisição contém dados inválidos.',
      )
    }

    request.log.error({ err: error }, 'Erro interno ao processar a requisição')

    return sendError(
      reply,
      500,
      'INTERNAL_ERROR',
      'Não foi possível concluir a solicitação.',
    )
  })
}
