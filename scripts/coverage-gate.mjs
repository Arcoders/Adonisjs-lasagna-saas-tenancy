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
 *   COV_MIN_LINES      (default 80)
 *   COV_MIN_FUNCTIONS  (default 78)
 *   COV_MIN_BRANCHES   (default 77)
 *
 * The defaults mirror the measured-and-ratcheted values ci.yml exports (the
 * canonical gate — see the "Coverage gate (aggregate)" step), NOT the much
 * lower unit floors this script originally defaulted to. That way a run that
 * loses the env wiring fails loudly instead of silently gating at a level
 * every report clears. Ratchet ci.yml and these defaults together.
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'coverage-combined.info'

const thresholds = {
  lines: Number(process.env.COV_MIN_LINES ?? 80),
  functions: Number(process.env.COV_MIN_FUNCTIONS ?? 78),
  branches: Number(process.env.COV_MIN_BRANCHES ?? 77),
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
