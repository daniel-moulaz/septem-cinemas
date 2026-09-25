import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { FastifyInstance } from 'fastify'
import { openApiSchemas } from './openapi.schemas.js'

const API_VERSION = '0.1.0'

export function registerOpenApi(app: FastifyInstance) {
  app.register(swagger, {
    mode: 'dynamic',
    hideUntagged: true,
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'SEPTEM API',
        description:
          'API da plataforma de sessões e ingressos de cinema SEPTEM.',
        version: API_VERSION,
      },
      tags: [
        { name: 'Health', description: 'Disponibilidade da API.' },
        {
          name: 'Auth',
          description: 'Autenticação e identificação do usuário atual.',
        },
        {
          name: 'Catalog',
          description: 'Consulta à TMDb para seleção de filmes.',
        },
        {
          name: 'Sessions',
          description: 'Programação pública e disponibilidade de assentos.',
        },
        {
          name: 'Organizer',
          description: 'Criação, edição e publicação de sessões.',
        },
        {
          name: 'Reservations',
          description: 'Reservas temporárias de assentos.',
        },
        {
          name: 'Payments',
          description: 'Processamento demonstrativo de pagamento.',
        },
        {
          name: 'Tickets',
          description: 'Ingressos digitais do cliente.',
        },
        {
          name: 'Sharing',
          description: 'Compartilhamento público e revogável de ingressos.',
        },
        {
          name: 'Gate',
          description: 'Validação e consumo de ingressos na portaria.',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Use o accessToken retornado por POST /auth/login. No botão Authorize, informe apenas o token.',
          },
        },
        schemas: openApiSchemas,
      },
    },
  })

  app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    uiConfig: {
      deepLinking: true,
      displayOperationId: false,
      displayRequestDuration: true,
      docExpansion: 'list',
      filter: true,
    },
  })
}
