/**
 * `npm run bench:check` — compare the newest results against a committed
 * baseline and print a regression verdict.
 *
 *   --baseline=ci-ubuntu   (default; the gate baseline)
 *   --baseline=1.0.0       (the docs baseline; for a self-compare sanity check)
 *
 * Higher ops/sec is always better (micro = ops/sec, DB/HTTP = throughput/req-s),
 * so a regression is a DROP below the per-tier tolerance. Informational by
 * default (exit 0); set BENCH_GATE_ENFORCE=1 to fail the build on a regression
 * once the baseline has stabilized over a few runs.
 */
import { readFileSync } from 'node:fs'
import { latestBySuiteDriver } from './results.js'

interface BaselineFile {
  capturedEnv: unknown
  index: Record<string, Record<string, { opsPerSec: number; nsMedian: number }>>
}

const baselineName =
  process.argv.find((a) => a.startsWith('--baseline='))?.split('=')[1] ??
  process.env.BENCH_BASELINE ??
  'ci-ubuntu'

const ENFORCE = process.env.BENCH_GATE_ENFORCE === '1'

// Per-tier tolerance: micro is machine-stable, DB/HTTP are noisier.
function tolerance(suiteKey: string): number {
  return suiteKey.startsWith('micro') ? 0.25 : 0.4
}

let baseline: BaselineFile
try {
  baseline = JSON.parse(readFileSync(new URL(`../../baselines/${baselineName}.json`, import.meta.url), 'utf8'))
} catch {
  // eslint-disable-next-line no-console
  console.log(
    `No baseline "${baselineName}.json" found. Capture one with ` +
      `\`npm run bench:report -- --write-baseline=${baselineName}\` first. Skipping check.`
  )
  process.exit(0)
}

const latest = latestBySuiteDriver()

// Correctness gate (always hard, independent of the throughput tolerance and of
// BENCH_GATE_ENFORCE): any result whose meta carries a `*Check` field set to
// 'FAIL' is a correctness regression — a cross-tenant leak, a broken fail
// policy, an unstable soak. These must never be merged, noisy runner or not.
const correctnessFailures: string[] = []
for (const [key, file] of latest) {
  for (const r of file.results) {
    for (const [metaKey, metaVal] of Object.entries(r.meta ?? {})) {
      if (metaKey.endsWith('Check') && metaVal === 'FAIL') {
        const label = r.group ? `${r.group} › ${r.name}` : r.name
        correctnessFailures.push(`✗ ${key} › ${label}: ${metaKey}=FAIL`)
      }
    }
  }
}
if (correctnessFailures.length) {
  // eslint-disable-next-line no-console
  console.error('\nCORRECTNESS GATE FAILED (hard, ignores tolerance):')
  // eslint-disable-next-line no-console
  for (const line of correctnessFailures) console.error(line)
}

const regressions: string[] = []
let compared = 0

for (const [key, file] of latest) {
  const base = baseline.index[key]
  if (!base) continue
  const tol = tolerance(key)
  for (const r of file.results) {
    const label = r.group ? `${r.group} › ${r.name}` : r.name
    const b = base[label]
    if (!b || !b.opsPerSec) continue
    compared++
    const delta = (r.opsPerSec - b.opsPerSec) / b.opsPerSec
    const flag = delta < -tol
    const arrow = delta >= 0 ? '+' : ''
    const line = `${flag ? '✗' : '·'} ${key} › ${label}: ${arrow}${(delta * 100).toFixed(1)}% (tol -${(tol * 100).toFixed(0)}%)`
    // eslint-disable-next-line no-console
    console.log(line)
    if (flag) regressions.push(line)
  }
}

// eslint-disable-next-line no-console
console.log(
  `\nCompared ${compared} metric(s) against baseline "${baselineName}". ` +
    `${regressions.length} regression(s).`
)

if (correctnessFailures.length) {
  // eslint-disable-next-line no-console
  console.error(`\n${correctnessFailures.length} correctness failure(s) — failing the build.`)
  process.exit(1)
}

if (regressions.length && ENFORCE) {
  // eslint-disable-next-line no-console
  console.error('Regression gate FAILED (BENCH_GATE_ENFORCE=1).')
  process.exit(1)
}
process.exit(0)
