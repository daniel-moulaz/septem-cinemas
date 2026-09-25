import { buildApp } from './app.js'
import { env } from './config/env.js'
import { prisma } from './lib/prisma.js'
import { loggerOptions } from './http/logger.js'

const app = buildApp({
  // Atrás do proxy da plataforma, sem isto `request.ip` seria o endereço do
  // proxy para todos os clientes e o limite de abuso do login valeria para o
  // conjunto em vez de por cliente.
  trustProxy: env.TRUST_PROXY,
  logger: loggerOptions,
})

let isShuttingDown = false

async function shutdown(reason: NodeJS.Signals | 'STARTUP_ERROR') {
  if (isShuttingDown) {
    return
  }

  isShuttingDown = true
  app.log.info({ reason }, 'Encerrando a API.')

  try {
    await app.close()
  } catch (error) {
    app.log.error(error)
    process.exitCode = 1
  }

  try {
    await prisma.$disconnect()
  } catch (error) {
    app.log.error(error)
    process.exitCode = 1
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
  await shutdown('STARTUP_ERROR')
}
