import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// No dotenv: the operator must explicitly select a local database server.
const url = new URL(process.env.DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  throw new Error('Concurrency proof requires an explicitly selected local PostgreSQL server.')
}
const database = `septem_proof_${randomUUID().replaceAll('-', '')}`
const admin = new pg.Client({ connectionString: url.href })
const scratch = await mkdtemp(join(tmpdir(), 'septem-proof-'))
const api = join(scratch, 'apps', 'api')
const abort = new AbortController()
const stop = () => abort.abort()
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
let created = false
let proofDatabase

function run(script, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: api, env, signal: abort.signal, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let spawnError
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', (error) => { spawnError = error })
    // Abort emits error before close. Wait for process termination before
    // dropping its database and removing the isolated source copy.
    child.once('close', (code) => spawnError ? reject(spawnError) : resolveRun({ code, output }))
  })
}

try {
  await admin.connect()
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  url.pathname = `/${database}`
  url.search = '?schema=public'
  const env = {
    ...process.env, DATABASE_URL: url.href, NODE_ENV: 'test',
    JWT_SECRET: 'proof_only_authentication_secret_2026',
    TICKET_SIGNING_SECRET: 'proof_only_distinct_ticket_secret_2026',
  }
  await cp(join(root, 'apps', 'api'), api, {
    recursive: true,
    filter: (path) => !['node_modules', 'dist'].includes(path.split(/[/\\]/).at(-1)),
  })
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'junction')
  await cp(join(root, 'tsconfig.base.json'), join(scratch, 'tsconfig.base.json'))
  const prisma = join(root, 'node_modules', 'prisma', 'build', 'index.js')
  for (const [script, args] of [
    [prisma, ['migrate', 'deploy']],
    [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), ['prisma/seed.ts']],
  ]) {
    const result = await run(script, args, env)
    if (result.code !== 0) throw new Error(result.output)
  }

  const lockTest = 'lets exactly one customer win A7 while the other receives 409'
  const indexTest = 'keeps one active allocation per seat as the database-level final defense'
  async function test(label, names, expectedFailure) {
    const report = join(scratch, 'result.json')
    await rm(report, { force: true })
    const result = await run(join(root, 'node_modules', 'vitest', 'vitest.mjs'), [
      'run', 'tests/reservations.integration.test.ts', '-t', names.join('|'),
      '--reporter=json', `--outputFile=${report}`,
    ], env)
    const json = JSON.parse(await readFile(report, 'utf8'))
    const assertions = json.testResults.flatMap((suite) => suite.assertionResults)
    const selected = assertions.filter((item) => names.includes(item.title))
    const failed = selected.filter((item) => item.status === 'failed')
    if (selected.length !== names.length || (expectedFailure
      ? result.code !== 1 || failed.length !== 1 || failed[0].title !== expectedFailure.name ||
        !failed[0].failureMessages.join('\n').includes(expectedFailure.message)
      : result.code !== 0 || selected.some((item) => item.status !== 'passed'))) {
      throw new Error(`Unexpected outcome in ${label}\n${result.output}\n${JSON.stringify(json)}`)
    }
    console.log(`${label}: ${expectedFailure ? 'mutation detected by the intended assertion' : 'passed'}`)
  }

  await test('Control: locks + unique index', [lockTest, indexTest])
  const sourcePath = join(api, 'src', 'modules', 'reservations', 'reservations.service.ts')
  const source = await readFile(sourcePath, 'utf8')
  const marker = source.indexOf('/* create-hold-lock-seats */')
  const end = source.indexOf('`)', marker)
  const lockQuery = source.slice(marker, end)
  if (marker < 0 || !lockQuery.includes('FOR UPDATE')) throw new Error('Lock mutation target changed.')
  await writeFile(sourcePath, source.slice(0, marker) + lockQuery.replace('FOR UPDATE', '') + source.slice(end))
  try {
    await test('Mutation A: remove Seat FOR UPDATE', [lockTest], {
      name: lockTest, message: 'As duas requisições não chegaram juntas ao lock do assento.',
    })
  } finally {
    await writeFile(sourcePath, source)
  }

  proofDatabase = new pg.Client({ connectionString: url.href })
  await proofDatabase.connect()
  await proofDatabase.query('DROP INDEX "ReservationSeat_active_seatId_key"')
  await test('Locks alone: HTTP arbitration remains protected', [lockTest])
  await test('Mutation B: remove active-allocation uniqueness', [indexTest], {
    name: indexTest, message: 'promise resolved',
  })
  await proofDatabase.query('CREATE UNIQUE INDEX "ReservationSeat_active_seatId_key" ON "ReservationSeat" ("seatId") WHERE "releasedAt" IS NULL')
  await test('Restored control', [lockTest, indexTest])
  console.log('Concurrency proof complete; original files were never modified.')
} finally {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  await proofDatabase?.end()
  try {
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
  } finally {
    await admin.end()
    // scratch is the exact directory returned by mkdtemp, never a user path.
    await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}
