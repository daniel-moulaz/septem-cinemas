import { Writable } from 'node:stream'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loggerOptions } from '../src/http/logger.js'

it('keeps bearer paths, query data and authorization out of request logs', async () => {
  let output = ''
  const stream = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback() } })
  const app = buildApp({ logger: { ...loggerOptions, stream } })
  try {
    await app.inject({ url: '/shared/private-bearer?token=private-query', headers: { authorization: 'Bearer private-authorization' } })
    // The valid route is silent; unmatched bearer paths still pass through
    // the default request logger and must also be redacted.
    await app.inject({ url: '/shared/private-bearer/unknown?token=private-query', headers: { authorization: 'Bearer private-authorization' } })
    expect(output).toContain('/shared/[REDACTED]')
    expect(output).not.toMatch(/private-bearer|private-query|private-authorization/)
  } finally { await app.close() }
})
