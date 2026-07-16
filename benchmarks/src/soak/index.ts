/**
 * Soak tier: long-running stability. Boots the fixture headless, provisions a
 * fixed tenant set, then drives a continuous mixed read/write churn at
 * concurrency for `BENCH_SOAK_HOURS`, sampling RSS/heap/external, live pg
 * backends and (Linux) open fds every `BENCH_SOAK_INTERVAL_S`. Emits a time
 * series and an automatic stability verdict: a sustained upward RSS slope or
 * unbounded backend growth fails `soakStableCheck`.
 *
 *   docker compose -f benchmarks/docker-compose.yml up -d
 *   BENCH_DRIVER=schema-pg BENCH_SOAK_HOURS=0.1 npm run bench:soak
 */
import { readdirSync } from 'node:fs'
import { bootBenchApp, terminateBenchApp, getDb } from '../harness/ignitor.js'
import { zeroMetric, type BenchResult } from '../harness/runner.js'
import { writeResult } from '../harness/results.js'
import { activeDriver, seedAll, pgVersion } from '../harness/provision.js'
import { memorySnapshot, pgBackendCount } from '../harness/introspect.js'
import { sizes, DRIVER } from '../harness/config.js'
import { clientFor, selectMarker, insertIdentifiableNote } from '../db/queries.js'

interface Sample {
  tSec: number
  rssMB: number
  heapMB: number
  pgBackends: number
  fds: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Open fd count on Linux (/proc/self/fd); -1 where unavailable (Win/macOS). */
function openFds(): number {
  try {
    return readdirSync('/proc/self/fd').length
  } catch {
    return -1
  }
}

/** Least-squares slope of y over x (per x-unit). 0 if degenerate. */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    // `i < n = xs.length`; callers pass `ys` of equal length.
    num += (xs[i]! - mx) * (ys[i]! - my)
    den += (xs[i]! - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}

const app = await bootBenchApp()
let exitCode = 0
try {
  const db = await getDb()
  const pg = await pgVersion(db)
  const driver = await activeDriver(app)

  const tenants = Math.max(20, sizes.churn.caps[sizes.churn.caps.length - 1]! * 2)

  console.log(`Soak: provisioning ${tenants} tenants (${DRIVER})…`)
  const { refs } = await seedAll(app, db, { tenants, rows: 50 })

  const durationMs = Math.round(sizes.soak.hours * 3600 * 1000)
  const intervalMs = sizes.soak.intervalSec * 1000
  const concurrency = sizes.soak.concurrency
  const deadline = Date.now() + durationMs
  const t0 = Date.now()

  console.log(
    `Soak: running ${sizes.soak.hours}h (${concurrency} workers, sample every ${sizes.soak.intervalSec}s)…`
  )

  let stop = false
  let ops = 0

  const worker = async () => {
    let i = Math.floor(Math.random() * refs.length)
    while (!stop && Date.now() < deadline) {
      const ref = refs[i++ % refs.length]! // modulo of the non-empty seeded `refs`
      const conn = await clientFor(driver, db, ref)
      if (i % 5 === 0) await insertIdentifiableNote(conn, driver, ref, ops)
      else await selectMarker(conn, driver, ref)
      ops++
    }
  }

  const series: Sample[] = []
  const sampler = async () => {
    while (!stop && Date.now() < deadline) {
      await sleep(intervalMs)
      const mem = memorySnapshot()
      series.push({
        tSec: Math.round((Date.now() - t0) / 1000),
        rssMB: mem.rssMB,
        heapMB: mem.heapUsedMB,
        pgBackends: await pgBackendCount(db),
        fds: openFds(),
      })

      console.log(`  t=${series[series.length - 1]!.tSec}s rss=${mem.rssMB}MB ops=${ops}`)
    }
  }

  await Promise.all([sampler(), ...Array.from({ length: concurrency }, () => worker())])
  stop = true

  // Verdict over the STABLE region only: RSS ramps during JIT/pool warmup and
  // then plateaus, so a slope over the whole window (warmup included) reads as a
  // huge false-positive leak. Drop a warmup prefix (~first quartile) and measure
  // the slope of what remains.
  const warmupDrop =
    series.length >= 4
      ? Math.min(series.length - 3, Math.max(1, Math.floor(series.length * 0.25)))
      : 0
  const stable = series.slice(warmupDrop)
  const xs = stable.map((s) => s.tSec)
  const rssSlopePerSec = slope(
    xs,
    stable.map((s) => s.rssMB)
  )
  const rssSlopeMBPerHour = Math.round(rssSlopePerSec * 3600 * 10) / 10
  const backendsStart = stable[0]?.pgBackends ?? 0
  const backendsEnd = series[series.length - 1]?.pgBackends ?? 0
  // Backends legitimately ramp to ~tenants during warmup and then plateau, so a
  // post-warmup baseline is already near peak; comparing end-vs-start would miss a
  // slow leak. Measure the SLOPE of backends over the stable region instead (same
  // approach as RSS): after warmup it should be flat, and sustained growth is a
  // connection leak.
  const backendsSlopePerHour =
    Math.round(
      slope(
        xs,
        stable.map((s) => s.pgBackends)
      ) *
        3600 *
        10
    ) / 10
  // Thresholds: >25 MB/h sustained RSS growth, or >10 backends/h sustained growth
  // after warmup, is a leak signal worth a hard fail. Tunable off the baseline.
  const RSS_SLOPE_LIMIT = 25
  const BACKENDS_SLOPE_LIMIT = 10
  const leakySlope = stable.length >= 3 && rssSlopeMBPerHour > RSS_SLOPE_LIMIT
  const runawayBackends = stable.length >= 3 && backendsSlopePerHour > BACKENDS_SLOPE_LIMIT
  const soakStableCheck = leakySlope || runawayBackends ? 'FAIL' : 'PASS'

  const result: BenchResult = zeroMetric(
    `soak ${sizes.soak.hours}h (${tenants} tenants, C=${concurrency})`,
    {
      hours: sizes.soak.hours,
      tenants,
      concurrency,
      ops,
      samples: series.length,
      warmupSamplesDropped: warmupDrop,
      rssStartMB: series[0]?.rssMB ?? 0,
      rssStableStartMB: stable[0]?.rssMB ?? 0,
      rssEndMB: series[series.length - 1]?.rssMB ?? 0,
      rssSlopeMBPerHour,
      backendsStart,
      backendsEnd,
      backendsSlopePerHour,
      fdsEnd: series[series.length - 1]?.fds ?? -1,
      soakStableCheck,
      series,
    },
    'soak'
  )

  console.log(
    `Soak done: ${ops} ops, RSS ${result.meta?.rssStartMB}→${result.meta?.rssEndMB}MB ` +
      `(${rssSlopeMBPerHour} MB/h), backends ${backendsStart}→${backendsEnd} (${backendsSlopePerHour}/h), ${soakStableCheck}`
  )
  writeResult('soak', [result], { pgVersion: pg })
  if (soakStableCheck === 'FAIL') exitCode = 1
} catch (error) {
  exitCode = 1

  console.error(error)
} finally {
  await terminateBenchApp(app)
}
process.exit(exitCode)
