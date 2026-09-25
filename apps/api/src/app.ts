import cors from '@fastify/cors'
import Fastify, { type FastifyServerOptions } from 'fastify'
import { env } from './config/env.js'
import { registerErrorHandler } from './http/error-response.js'
import { registerSecurityHeaders } from './http/security-headers.js'
import { registerAuth } from './modules/auth/register-auth.js'
import {
  catalogRoutes,
  createTmdbCatalog,
  type MovieCatalog,
} from './modules/catalog/index.js'
import { registerPublicSessions } from './modules/public-sessions/register-public-sessions.js'
import { registerPayments } from './modules/payments/index.js'
import { registerGate } from './modules/gate/index.js'
import { registerReservations } from './modules/reservations/index.js'
import { registerSharedTickets } from './modules/shared-tickets/index.js'
import { registerSessions } from './modules/sessions/register-sessions.js'
import { registerTickets } from './modules/tickets/index.js'
import { apiDocumentation } from './openapi/openapi.operations.js'
import { registerOpenApi } from './openapi/register-openapi.js'

interface AppDependencies {
  movieCatalog?: MovieCatalog
}

export function buildApp(
  options: FastifyServerOptions = {},
  dependencies: AppDependencies = {},
) {
  const app = Fastify(options)
  registerOpenApi(app)

  const movieCatalog =
    dependencies.movieCatalog ??
    createTmdbCatalog(
      env.TMDB_READ_ACCESS_TOKEN
        ? { accessToken: env.TMDB_READ_ACCESS_TOKEN }
        : {},
    )

  registerErrorHandler(app)
  registerSecurityHeaders(app)
  app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Retry-After'],
  })
  registerAuth(app)
  app.register(catalogRoutes, { prefix: '/catalog', catalog: movieCatalog })
  registerSessions(app, movieCatalog)
  registerPublicSessions(app)
  registerReservations(app)
  registerPayments(app)
  registerTickets(app, { signingSecret: env.TICKET_SIGNING_SECRET })
  registerGate(app, { signingSecret: env.TICKET_SIGNING_SECRET })
  registerSharedTickets(app, {
    signingSecret: env.TICKET_SIGNING_SECRET,
    webOrigin: env.WEB_ORIGIN,
  })

  app.register(async (healthApp) => {
    healthApp.get(
      '/health',
      { config: { swaggerTransform: apiDocumentation.health } },
      async () => ({ status: 'ok' }),
    )
  })

  return app
}
