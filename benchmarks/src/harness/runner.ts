/**
 * A small, self-contained micro-benchmark runner.
 *
 * We deliberately do NOT depend on mitata/tinybench here: the committed
 * baselines need deterministic, version-stable JSON, and a hrtime sampling loop
 * we own is the most reliable source of that. The runner amortizes timer
 * overhead by timing a calibrated batch of iterations, collects a fixed number
 * of samples, and reports median / p99 / stddev. GC is forced between samples
 * when the process was started with `--expose-gc` (the `bench:micro` script
 * passes it).
 */

export interface BenchStats {
  mean: number
  median: number
  p75: number
  p99: number
  p999: number
  min: number
  max: number
  stddev: number
}

export interface BenchResult {
  name: string
  group?: string
  samples: number
  opsPerSec: number
  /** Per-operation timing, nanoseconds. */
  ns: BenchStats
  meta?: Record<string, unknown>
}

export interface MicroOptions {
  group?: string
  warmupMs?: number
  sampleCount?: number
  /** Override the auto-calibrated iterations-per-sample. */
  batch?: number
  meta?: Record<string, unknown>
}

const now = (): bigint => process.hrtime.bigint()

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1)
  )
  return sortedAsc[idx]
}

export function summarize(
  name: string,
  nsPerOpSamples: number[],
  opts: { group?: string; meta?: Record<string, unknown> } = {}
): BenchResult {
  const sorted = [...nsPerOpSamples].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(1, n)
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n)
  const median = percentile(sorted, 50)
  return {
    name,
    group: opts.group,
    samples: n,
    opsPerSec: median > 0 ? 1e9 / median : 0,
    ns: {
      mean,
      median,
      p75: percentile(sorted, 75),
      p99: percentile(sorted, 99),
      p999: percentile(sorted, 99.9),
      min: sorted[0] ?? 0,
      max: sorted[n - 1] ?? 0,
      stddev: Math.sqrt(variance),
    },
    meta: opts.meta,
  }
}

/**
 * A metric-only data point whose value lives in `meta` (open connections, RSS,
 * pg_class rows, …) rather than in a timing distribution. Zero timings so the
 * regression gate skips it; the report renders its meta instead.
 */
export function zeroMetric(
  name: string,
  meta: Record<string, unknown>,
  group?: string
): BenchResult {
  return {
    name,
    group,
    samples: 0,
    opsPerSec: 0,
    ns: { mean: 0, median: 0, p75: 0, p99: 0, p999: 0, min: 0, max: 0, stddev: 0 },
    meta,
  }
}

function calibrateBatch(fn: () => unknown): number {
  let batch = 1
  for (;;) {
    const t0 = now()
    for (let i = 0; i < batch; i++) fn()
    const dt = Number(now() - t0)
    // Target ≥ 0.2 ms per batch so the timer's resolution is negligible.
    if (dt >= 200_000 || batch >= 1_000_000) return batch
    batch *= 2
  }
}

/** Benchmark a synchronous function. */
export function runMicro(name: string, fn: () => unknown, opts: MicroOptions = {}): BenchResult {
  const warmupMs = opts.warmupMs ?? 250
  const sampleCount = opts.sampleCount ?? 40

  // Pre-warm to settle the JIT BEFORE calibrating the batch size. A cold first
  // call (especially for the first bench in the process) would otherwise be
  // slow enough to force batch=1, making the whole measurement timer-noisy.
  const preWarmEnd = Date.now() + Math.min(150, warmupMs)
  while (Date.now() < preWarmEnd) {
    for (let i = 0; i < 1000; i++) fn()
  }

  const batch = opts.batch ?? calibrateBatch(fn)

  // Warmup at the chosen batch.
  const warmEnd = Date.now() + warmupMs
  while (Date.now() < warmEnd) {
    for (let i = 0; i < batch; i++) fn()
  }

  const samples: number[] = []
  for (let s = 0; s < sampleCount; s++) {
    if (typeof globalThis.gc === 'function') globalThis.gc()
    const t0 = now()
    for (let i = 0; i < batch; i++) fn()
    const dt = Number(now() - t0)
    samples.push(dt / batch)
  }

  return summarize(name, samples, { group: opts.group, meta: { ...opts.meta, batch } })
}

/**
 * Measure an async operation's latency over `iterations` awaited calls (with a
 * short warmup). Used by the DB/HTTP tiers where each op is a real round-trip
 * and we care about the p50/p99 latency distribution rather than ns/op.
 */
export async function measureLatency(
  name: string,
  iterations: number,
  fn: () => Promise<unknown>,
  opts: { group?: string; warmup?: number; meta?: Record<string, unknown> } = {}
): Promise<BenchResult> {
  const warm = Math.min(iterations, opts.warmup ?? 20)
  for (let i = 0; i < warm; i++) await fn()

  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = now()
    await fn()
    samples.push(Number(now() - t0))
  }
  return summarize(name, samples, { group: opts.group, meta: opts.meta })
}

/** Pretty console table for a set of results. */
export function printResults(title: string, results: BenchResult[]): void {
  console.log(`\n${title}`)
  const rows = results.map((r) => ({
    'name': r.group ? `${r.group} › ${r.name}` : r.name,
    'ns/op (median)': Math.round(r.ns.median).toLocaleString(),
    'p99': Math.round(r.ns.p99).toLocaleString(),
    'ops/sec': Math.round(r.opsPerSec).toLocaleString(),
    '± stddev': Math.round(r.ns.stddev).toLocaleString(),
  }))

  console.table(rows)
}

/** Console table for metric-only (zeroMetric) results: one row per data point, columns from meta. */
export function printMetricResults(title: string, results: BenchResult[]): void {
  console.log(`\n${title}`)
  const rows = results.map((r) => ({
    metric: r.group ? `${r.group} › ${r.name}` : r.name,
    ...(r.meta ?? {}),
  }))

  console.table(rows)
}
