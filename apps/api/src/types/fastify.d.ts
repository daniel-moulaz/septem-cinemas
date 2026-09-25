import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Role } from '../generated/prisma/enums.js'
import type { PublicUser } from '../modules/auth/auth.types.js'

type AuthPreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { role: Role; sub?: string }
    user: { role: Role; sub?: string; iss?: unknown; aud?: unknown }
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: PublicUser | null
  }

  interface FastifyInstance {
    authenticate: AuthPreHandler
    authorizeRoles: (...roles: Role[]) => AuthPreHandler
  }
}

export {}
