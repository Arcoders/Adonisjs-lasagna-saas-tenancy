/**
 * Resilience tier — fault injection + recovery. Boots the served fixture, then
 * kills Redis and Postgres (via `docker stop/start`) and asserts the package's
 * REAL failure policy per dependency, plus recovery:
 *
 *   - Redis down + rate-limited route → 503 (RateLimitUnavailableException;
 *     fail-closed is the default). A 200 would be a silent fail-open leak.
 *     The non-rate-limited tenant route must stay 200 (Redis-independent).
 *   - Postgres down + tenant route → 503 (DependencyUnavailableException). The
 *     tenant path fails closed: `request.tenant()` maps an unreachable tenant
 *     registry / connection to a clean 503 instead of a raw Lucid 500. A 500
 *     here is now a regression. Recovery after restart is also asserted.
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

/** Poll until `accept(status)` is true; returns elapsed ms, or -1 on timeout. */
async function pollUntil(
  path: string,
  tenantId: string,
  timeoutMs: number,
  accept: (status: number) => boolean
): Promise<number> {
  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  for (;;) {
    if (accept(await status(path, tenantId))) return Date.now() - t0
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
  console.log('Resilience tier skipped (set BENCH_RESILIENCE=1 to run). No result written.')
  process.exit(0)
}
if (!dockerOk()) {
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
  const redisStopped = docker('stop', redisContainer)
  await sleep(1500)
  const rlDown = await status('/ratelimited/notes', tenant)
  const tenantDuringRedisDown = await status('/tenant/notes', tenant) // Redis-independent
  docker('start', redisContainer)
  // Recovered once the limiter responds with anything other than its fail-closed
  // 503 (a 200, or a 429 because the pre-outage burst still fills the window —
  // both prove Redis is reachable again). Requiring strictly 200 would misread a
  // lingering 429 as "never recovered".
  const rlRecoveredMs = await pollUntil(
    '/ratelimited/notes',
    tenant,
    recoveryTimeoutMs,
    (s) => s !== 503 && s !== 0
  )

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
        containerStopped: redisStopped,
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

  // --- Scenario B: Postgres down (tenant route fails closed + recovery) ---
  const pgStopped = docker('stop', pgContainer)
  await sleep(1500)
  // Sample a few times: right after `docker stop`, the first probe can time out
  // (status 0) before the socket cleanly refuses. The policy is proven if ANY
  // sample is a clean 503 and NONE is a 200 (a served read = leak / fail-open).
  // A 500 with no 503 is a regression (the macro maps DB outages to a 503); a
  // run of only 0s means the request hung throughout.
  const pgDownSamples: number[] = []
  for (let i = 0; i < 3; i++) {
    pgDownSamples.push(await status('/tenant/notes', tenant))
    if (i < 2) await sleep(500)
  }
  docker('start', pgContainer)
  const pgRecoveredMs = await pollUntil(
    '/tenant/notes',
    tenant,
    recoveryTimeoutMs,
    (s) => s === 200
  )

  const pgSaw503 = pgDownSamples.includes(503)
  const pgSaw200 = pgDownSamples.includes(200)
  const pgSaw500 = pgDownSamples.includes(500)
  const pgPolicyObserved = pgSaw200
    ? 'FAIL-OPEN (200: tenant route served a read while PG was down)'
    : pgSaw503
      ? 'fail-closed (503, correct)'
      : pgSaw500
        ? 'REGRESSION (raw 500 Lucid error, not mapped to a 503 policy)'
        : 'hung/timeout (no definitive status observed)'
  // Hard assertion: PG was really stopped, the tenant route returned a clean 503
  // at least once, never served a 200, and recovered after restart.
  const pgPass = pgStopped && pgSaw503 && !pgSaw200 && pgRecoveredMs >= 0
  results.push(
    zeroMetric(
      'postgres down → tenant route fail-closed + recovery',
      {
        dependency: 'postgres',
        containerStopped: pgStopped,
        observedStatuses: pgDownSamples,
        expectedStatus: 503,
        policyObserved: pgPolicyObserved,
        recoveredWithinMs: pgRecoveredMs,
        failPolicyCheck: pgPass ? 'PASS' : 'FAIL',
      },
      'resilience'
    )
  )

  printMetricResults(`Resilience (driver: ${DRIVER})`, results)
  writeResult('resilience', results, { pgVersion: pg })
  if (results.some((r) => r.meta?.failPolicyCheck === 'FAIL')) exitCode = 1
} catch (error) {
  exitCode = 1

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
