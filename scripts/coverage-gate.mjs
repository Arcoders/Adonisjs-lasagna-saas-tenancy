#!/usr/bin/env node
/**
 * Coverage gate over a merged lcov file.
 *
 * Why this exists: the unit run is gated in-process by .c8rc, but the only way
 * to get a single number that also reflects the integration suite is to merge
 * the unit + integration lcov reports in CI. This script parses that merged
 * lcov, prints line/function/branch totals, and exits non-zero when any metric
 * falls below its threshold so the aggregate becomes a real gate, not a report.
 *
 * Usage:
 *   node scripts/coverage-gate.mjs [path/to/lcov.info]
 *
 * Thresholds (percent) come from the environment so CI can ratchet them up
 * without touching code:
 *   COV_MIN_LINES      (default 34)
 *   COV_MIN_FUNCTIONS  (default 58)
 *   COV_MIN_BRANCHES   (default 70)
 *
 * The defaults mirror the unit floors in .c8rc.json. A merged report can only
 * cover MORE than the unit run (hits are a union), so these defaults never
 * produce a false failure; raise them once a CI run prints the real aggregate.
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'coverage-combined.info'

const thresholds = {
  lines: Number(process.env.COV_MIN_LINES ?? 34),
  functions: Number(process.env.COV_MIN_FUNCTIONS ?? 58),
  branches: Number(process.env.COV_MIN_BRANCHES ?? 70),
}

let raw
try {
  raw = readFileSync(file, 'utf8')
} catch (err) {
  console.error(`coverage-gate: cannot read lcov file "${file}": ${err.message}`)
  process.exit(2)
}

// lcov per-record tallies: LF/LH (lines), FNF/FNH (functions), BRF/BRH (branches).
const totals = { LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 }
for (const line of raw.split(/\r?\n/)) {
  const colon = line.indexOf(':')
  if (colon === -1) continue
  const key = line.slice(0, colon)
  if (totals[key] === undefined) continue
  const value = Number(line.slice(colon + 1))
  if (Number.isFinite(value)) totals[key] += value
}

// A metric with no findable units (e.g. no branches at all) is treated as 100%.
const pct = (hit, found) => (found === 0 ? 100 : (hit / found) * 100)

const results = {
  lines: pct(totals.LH, totals.LF),
  functions: pct(totals.FNH, totals.FNF),
  branches: pct(totals.BRH, totals.BRF),
}

const round = (n) => Math.round(n * 100) / 100
let failed = false
const rows = []
for (const metric of ['lines', 'functions', 'branches']) {
  const actual = round(results[metric])
  const min = thresholds[metric]
  const ok = actual >= min
  if (!ok) failed = true
  rows.push(
    `  ${metric.padEnd(10)} ${String(actual).padStart(6)}%   (min ${String(min).padStart(3)}%)   ${ok ? 'ok' : 'FAIL'}`
  )
}

console.log(`Coverage gate — ${file}`)
console.log(rows.join('\n'))

if (failed) {
  console.error('\ncoverage-gate: merged coverage is below threshold')
  process.exit(1)
}
console.log('\ncoverage-gate: passed')
