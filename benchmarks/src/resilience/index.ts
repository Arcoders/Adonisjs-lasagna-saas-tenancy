/**
 * Resilience tier — fault injection + recovery. Boots the served fixture, then
 * kills Redis and Postgres (via `docker stop/start`) and asserts the package's
 * REAL failure policy per dependency, plus recovery:
 *
 *   - Redis down + rate-limited route → 503 (RateLimitUnavailableException;
 *     fail-closed is the default). A 200 would be a silent fail-open leak.
 *     The non-rate-limited tenant route must stay 200 (Redis-independent).
 *   - Postgres down + tenant route → currently a 500 (raw Lucid error, NOT a
 *     clean 503): documented here as a finding. Recovery after restart is the
 *     hard assertion.
 *
 * Opt-in (needs Docker + controllable containers):
 *   BENCH_RESILIENCE=1 BENCH_REDIS_CONTAINER=… BENCH_PG_CONTAINER=… \
 *     BENCH_DRIVER=schema-pg npm run bench:resilience
 */
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bootBenchApp, terminateBenchApp, getDb } from '../harness/ignitor.js'
import { seedAll, pgVersion } from '../harness/provision.js'
import { printMetricResults, zeroMetric, type BenchResult } from '../harness/runner.js'
import { writeResult } from '../harness/results.js'
import { sizes, DRIVER } from '../harness/config.js'

const HOST = '127.0.0.1'
const PORT = Number(process.env.BENCH_RESILIENCE_PORT ?? 3366)
const BASE_URL = `http://${HOST}:${PORT}`
const HEADER = process.env.TENANT_HEADER_KEY ?? 'x-tenant-id'
const SERVER_ENTRY = fileURLToPath(new URL('../../fixture/bin/server.ts', import.meta.url))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function dockerOk(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function docker(action: 'stop' | 'start', name: string): boolean {
  try {
    execFileSync('docker', [action, name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** GET status, or 0 on transport error/timeout. */
async function status(path: string, tenantId: string, timeoutMs = 8000): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { [HEADER]: tenantId },
      signal: controller.signal,
    })
    return res.status
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
  }
}

async function pollUntil200(path: string, tenantId: string, timeoutMs: number): Promise<number> {
  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  for (;;) {
    if ((await status(path, tenantId)) === 200) return Date.now() - t0
    if (Date.now() >= deadline) return -1
    await sleep(500)
  }
}

async function waitForReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE_URL}/ceiling`)).ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`Bench server did not become ready on ${BASE_URL}`)
}

// Skip cleanly (report-as-skipped) when not opted in or Docker is unavailable —
// same convention as the real-API Stripe smoke spec.
if (!sizes.resilience.enabled) {
  // eslint-disable-next-line no-console
  console.log('Resilience tier skipped (set BENCH_RESILIENCE=1 to run). No result written.')
  process.exit(0)
}
if (!dockerOk()) {
  // eslint-disable-next-line no-console
  console.log('Resilience tier skipped: docker CLI not available.')
  process.exit(0)
}

const { redisContainer, pgContainer, recoveryTimeoutMs } = sizes.resilience

// 1) Seed a few tenants in-process, then release.
const seedApp = await bootBenchApp()
let tenantIds: string[] = []
let pg: string | null = null
try {
  const db = await getDb()
  pg = await pgVersion(db)
  const seeded = await seedAll(seedApp, db, { tenants: 5, rows: 10 })
  tenantIds = seeded.ids
} finally {
  await terminateBenchApp(seedApp)
}
const tenant = tenantIds[0]

// 2) Spawn the serving fixture (development → rate-limit middleware runs).
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

const results: BenchResult[] = []
let exitCode = 0
try {
  await waitForReady()

  // --- Scenario A: Redis down (rate-limit fail-closed) ---
  const baselineRl = await status('/ratelimited/notes', tenant)
  docker('stop', redisContainer)
  await sleep(1500)
  const rlDown = await status('/ratelimited/notes', tenant)
  const tenantDuringRedisDown = await status('/tenant/notes', tenant) // Redis-independent
  docker('start', redisContainer)
  const rlRecoveredMs = await pollUntil200('/ratelimited/notes', tenant, recoveryTimeoutMs)

  // The documented default is fail-closed (503). Classify what actually happened.
  const policyObserved =
    rlDown === 503
      ? 'fail-closed (503, correct)'
      : rlDown === 200
        ? 'FAIL-OPEN (200: request allowed while Redis down)'
        : rlDown === 0
          ? 'hung/timeout (neither served nor cleanly rejected)'
          : `unexpected (${rlDown})`
  const redisPass =
    baselineRl === 200 && rlDown === 503 && tenantDuringRedisDown === 200 && rlRecoveredMs >= 0
  results.push(
    zeroMetric(
      'redis down → rate-limit fail-closed',
      {
        dependency: 'redis',
        baselineStatus: baselineRl,
        observedStatus: rlDown,
        expectedStatus: 503,
        policyObserved,
        tenantRouteDuringOutage: tenantDuringRedisDown,
        recoveredWithinMs: rlRecoveredMs,
        failPolicyCheck: redisPass ? 'PASS' : 'FAIL',
        note:
          rlDown === 200
            ? 'FINDING: pipeline.exec() resolves with [err,null] on Redis failure; ' +
              'middleware reads count=0 and allows the request → fail-OPEN despite failOpen=false. See issue 04.'
            : '',
      },
      'resilience'
    )
  )

  // --- Scenario B: Postgres down (documented behavior + recovery) ---
  docker('stop', pgContainer)
  await sleep(1500)
  const pgDown = await status('/tenant/notes', tenant)
  docker('start', pgContainer)
  const pgRecoveredMs = await pollUntil200('/tenant/notes', tenant, recoveryTimeoutMs)

  results.push(
    zeroMetric(
      'postgres down → tenant route + recovery',
      {
        dependency: 'postgres',
        observedStatus: pgDown, // documented: currently 500/0 (no clean 503 yet)
        note: 'PG outage is a raw Lucid error (500), not a 503 policy; see issue 04',
        recoveredWithinMs: pgRecoveredMs,
        // The hard assertion is recovery, not the (known) non-503 status.
        failPolicyCheck: pgRecoveredMs >= 0 ? 'PASS' : 'FAIL',
      },
      'resilience'
    )
  )

  printMetricResults(`Resilience (driver: ${DRIVER})`, results)
  writeResult('resilience', results, { pgVersion: pg })
  if (results.some((r) => r.meta?.failPolicyCheck === 'FAIL')) exitCode = 1
} catch (error) {
  exitCode = 1
  // eslint-disable-next-line no-console
  console.error(error)
  // Best-effort: make sure containers are back up even on error.
  docker('start', redisContainer)
  docker('start', pgContainer)
} finally {
  server.kill('SIGTERM')
  await sleep(500)
  if (!server.killed) server.kill('SIGKILL')
}
process.exit(exitCode)
