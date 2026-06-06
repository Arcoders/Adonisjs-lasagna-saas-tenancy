/**
 * Isolation tier entry. Same shape as http/index.ts (seed in-process → spawn the
 * fixture server → assert), but seeds tenant-identifiable rows and runs the
 * concurrent isolation assertion instead of throughput.
 *
 *   docker compose -f benchmarks/docker-compose.yml up -d
 *   BENCH_DRIVER=schema-pg npm run bench:isolation
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bootBenchApp, terminateBenchApp, getDb } from '../src/harness/ignitor.js'
import { provisionTenants, seedIdentifiableNotes, pgVersion } from '../src/harness/provision.js'
import { printMetricResults } from '../src/harness/runner.js'
import { writeResult } from '../src/harness/results.js'
import { sizes, DRIVER, HTTP_NODE_ENV } from '../src/harness/config.js'
import { runIsolationLoad } from './isolation.bench.js'

const HOST = '127.0.0.1'
const PORT = Number(process.env.BENCH_ISO_PORT ?? 3355)
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

// 1) Seed identifiable rows in-process, capture ids + pg version, release the app.
const seedApp = await bootBenchApp()
let tenantIds: string[] = []
let pg: string | null = null
try {
  const db = await getDb()
  pg = await pgVersion(db)
  // eslint-disable-next-line no-console
  console.log(`Seeding ${sizes.iso.tenants} identifiable tenants × ${sizes.iso.rows} rows (${DRIVER})…`)
  const seeded = await provisionTenants(seedApp, db, sizes.iso.tenants)
  await seedIdentifiableNotes(seedApp, db, seeded.refs, sizes.iso.rows)
  tenantIds = seeded.ids
} finally {
  await terminateBenchApp(seedApp)
}

// 2) Spawn the serving fixture; it re-registers the seeded tenants from BENCH_WARM_TENANT_IDS.
const server = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
  env: {
    ...process.env,
    BENCH_DRIVER: DRIVER,
    HOST,
    PORT: String(PORT),
    NODE_ENV: HTTP_NODE_ENV,
    BENCH_WARM_TENANT_IDS: tenantIds.join(','),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})

let exitCode = 0
try {
  await waitForReady()
  // eslint-disable-next-line no-console
  console.log(`Server ready at ${BASE_URL}; running isolation assertion…`)
  const results = await runIsolationLoad(BASE_URL, tenantIds)
  printMetricResults(`Isolation (driver: ${DRIVER}, NODE_ENV=${HTTP_NODE_ENV})`, results)
  // The self-test deliberately forces isolationCheck=FAIL to prove the detector
  // is not a no-op. Do NOT persist that result: a later `bench:check` scans the
  // newest file per suite via latestBySuiteDriver and would fail the gate on this
  // negative control. We still exit 1 below (CI inverts it), so detection is
  // asserted by the exit code, not by a written FAIL.
  if (sizes.iso.selftest) {
    // eslint-disable-next-line no-console
    console.log('Self-test mode: result not written (the expected FAIL must not reach the gate).')
  } else {
    writeResult('iso', results, {
      pgVersion: pg,
      meta: { tenants: sizes.iso.tenants, requests: sizes.iso.requests, concurrency: sizes.iso.concurrency },
    })
  }

  // Hard-fail the process on any cross-tenant leak, so the gate and CI catch it.
  const leaked = results.some((r) => r.meta?.isolationCheck === 'FAIL')
  if (leaked) {
    // eslint-disable-next-line no-console
    console.error('ISOLATION CHECK FAILED — cross-tenant data observed.')
    exitCode = 1
  }
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
