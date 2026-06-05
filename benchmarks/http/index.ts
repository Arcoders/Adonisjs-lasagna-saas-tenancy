/**
 * Tier 3 — HTTP end-to-end. Self-contained: seed the active driver in-process,
 * spawn the fixture HTTP server as a child (warming it before measuring), run
 * the autocannon scenarios, then tear the server down.
 *
 *   docker compose -f benchmarks/docker-compose.yml up -d
 *   BENCH_DRIVER=schema-pg npm run bench:http
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bootBenchApp, terminateBenchApp, getDb } from '../src/harness/ignitor.js'
import { seedAll, pgVersion } from '../src/harness/provision.js'
import { printResults } from '../src/harness/runner.js'
import { writeResult } from '../src/harness/results.js'
import { sizes, DRIVER } from '../src/harness/config.js'
import { runHttpLoad } from './load.bench.js'

const HOST = '127.0.0.1'
const PORT = Number(process.env.BENCH_HTTP_PORT ?? 3344)
const BASE_URL = `http://${HOST}:${PORT}`
const SERVER_ENTRY = fileURLToPath(new URL('../fixture/bin/server.ts', import.meta.url))

async function waitForReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/ceiling`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Bench server did not become ready on ${BASE_URL} within ${timeoutMs}ms`)
}

// 1) Seed in-process, capture tenant ids + pg version, then release the app.
const seedApp = await bootBenchApp()
let tenantIds: string[] = []
let pg: string | null = null
try {
  const db = await getDb()
  pg = await pgVersion(db)
  // eslint-disable-next-line no-console
  console.log(`Seeding ${sizes.http.tenants} tenants × ${sizes.http.rows} rows (${DRIVER})…`)
  const seeded = await seedAll(seedApp, db, { tenants: sizes.http.tenants, rows: sizes.http.rows })
  tenantIds = seeded.ids
} finally {
  await terminateBenchApp(seedApp)
}

// 2) Spawn the HTTP server child with the same driver + DB env. The seed app
// registered the tenant connections in ITS manager, then exited — so hand the
// child the seeded ids via BENCH_WARM_TENANT_IDS and let its provider's ready()
// hook re-register them in the serving process (otherwise every tenant route 500s).
const server = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
  env: {
    ...process.env,
    BENCH_DRIVER: DRIVER,
    HOST,
    PORT: String(PORT),
    NODE_ENV: 'development',
    BENCH_WARM_TENANT_IDS: tenantIds.join(','),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})

let exitCode = 0
try {
  await waitForReady()
  // eslint-disable-next-line no-console
  console.log(`Server ready at ${BASE_URL}; running autocannon scenarios…`)
  const results = await runHttpLoad(BASE_URL, tenantIds)
  printResults(`Tier 3 — HTTP (driver: ${DRIVER})`, results)
  writeResult('http', results, {
    pgVersion: pg,
    meta: { tenants: sizes.http.tenants, connections: sizes.http.connections, durationSec: sizes.http.durationSec },
  })
} catch (error) {
  exitCode = 1
  // eslint-disable-next-line no-console
  console.error(error)
} finally {
  server.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  if (!server.killed) server.kill('SIGKILL')
}
process.exit(exitCode)
