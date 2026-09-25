import fastifyJwt from '@fastify/jwt'
import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import {
  AUTH_TOKEN_AUDIENCE,
  AUTH_TOKEN_DURATION,
  AUTH_TOKEN_ISSUER,
} from './auth.constants.js'
import { authenticateRequest, authorizeRoles } from './auth.guards.js'
import { authRoutes } from './auth.routes.js'

export function registerAuth(app: FastifyInstance) {
  app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: {
      algorithm: 'HS256',
      expiresIn: AUTH_TOKEN_DURATION,
      iss: AUTH_TOKEN_ISSUER,
      aud: AUTH_TOKEN_AUDIENCE,
    },
    verify: {
      algorithms: ['HS256'],
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
      // authenticateRequest validates issuer/audience as a complete pair
      // after signature/expiration checks; independent lists admit mixed pairs.
    },
  })

  app.decorateRequest('authUser', null)
  app.decorate('authenticate', authenticateRequest)
  app.decorate('authorizeRoles', authorizeRoles)
  app.register(authRoutes, { prefix: '/auth' })
}
