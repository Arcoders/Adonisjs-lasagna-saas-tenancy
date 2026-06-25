#!/usr/bin/env node
/**
 * Per-satellite merged coverage gate.
 *
 * Why this exists: the repo already gates the *aggregate* merged (unit +
 * integration) coverage at a repo-wide level (scripts/coverage-gate.mjs), and
 * each satellite's unit run is gated in-process by its own .c8rc. But neither
 * proves that any *single* satellite is well tested: a controller-heavy
 * satellite (admin) has a deliberately low unit floor because its handlers are
 * exercised by the integration tier, not unit tests. The honest "is this
 * satellite RC-worthy" number is its MERGED (unit + integration) src coverage,
 * measured per package. This script reads the merged lcov, buckets records by
 * `packages/<dir>/src/`, and fails when an RC/stable satellite is below the
 * floor it declares in its own package.json.
 *
 * Floors are declarative, living in each satellite manifest under
 * `lasagnaSatellite.minMergedCoverage: { lines, functions, branches }`, so
 * ratcheting is a data edit (mirrors the .c8rc floor pattern). The structural
 * half of the gate (check-satellite-graduation.mjs) asserts the floor is
 * declared and at the graduation bar; this half enforces the actual number.
 *
 * Usage:
 *   node scripts/check-satellite-coverage.mjs [path/to/lcov.info]
 *
 * Set SATELLITE_COV_REPORT_ONLY=1 to print the table without failing — used for
 * the first CI run, to read the measured numbers before ratcheting each floor
 * just under its actual and flipping this to an enforcing gate.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const STABILITY_DOC = 'docs/reference/stability.md'
const PACKAGES_DIR = 'packages'
const lcovFile = process.argv[2] ?? 'coverage/lcov.info'
const reportOnly = process.env.SATELLITE_COV_REPORT_ONLY === '1'

/** package name -> normalized stability label, parsed from the satellite table. */
const labels = new Map()
let stabilityDoc
try {
  stabilityDoc = readFileSync(STABILITY_DOC, 'utf8')
} catch (err) {
  console.error(`check-satellite-coverage: cannot read stability doc "${STABILITY_DOC}": ${err.message}`)
  process.exit(2)
}
for (const m of stabilityDoc.matchAll(/^\|\s*`(@[\w-]+\/[\w-]+)`\s*\|\s*([A-Za-z ]+?)\s*\|/gm)) {
  labels.set(m[1], m[2].trim().toLowerCase())
}

/** dir -> { name, floors } for every RC/stable satellite that declares a floor. */
const satellites = []
for (const dir of readdirSync(PACKAGES_DIR)) {
  const manifestPath = join(PACKAGES_DIR, dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    console.error(`check-satellite-coverage: cannot parse ${manifestPath}: ${err.message}`)
    process.exit(2)
  }
  if (pkg.private || !pkg.lasagnaSatellite) continue
  const label = labels.get(pkg.name) ?? '(no label)'
  if (label !== 'release candidate' && label !== 'stable') continue
  const floors = pkg.lasagnaSatellite.minMergedCoverage
  if (!floors) {
    // The graduation gate enforces this; here we just skip so a missing floor
    // doesn't crash the report. It will fail the lint job separately.
    continue
  }
  satellites.push({ dir, name: pkg.name, floors })
}

let raw
try {
  raw = readFileSync(lcovFile, 'utf8')
} catch (err) {
  console.error(`check-satellite-coverage: cannot read lcov file "${lcovFile}": ${err.message}`)
  process.exit(2)
}

// Bucket lcov records by satellite. Each record is `SF:<path> ... end_of_record`;
// match the path against `packages/<dir>/src/` (normalize backslashes so an
// absolute Windows path matches too). Tally LF/LH (lines), FNF/FNH (functions),
// BRF/BRH (branches) per satellite.
const tally = new Map(satellites.map((s) => [s.dir, { LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 }]))
let current = null
for (const line of raw.split(/\r?\n/)) {
  if (line.startsWith('SF:')) {
    const sf = line.slice(3).replace(/\\/g, '/')
    current = satellites.find((s) => sf.includes(`${PACKAGES_DIR}/${s.dir}/src/`))?.dir ?? null
    continue
  }
  // Reset at record boundaries so a metric line that somehow appears without a
  // preceding SF (a malformed report) can't be attributed to the prior file.
  if (line === 'end_of_record') {
    current = null
    continue
  }
  if (!current) continue
  const colon = line.indexOf(':')
  if (colon === -1) continue
  const key = line.slice(0, colon)
  const t = tally.get(current)
  if (t[key] === undefined) continue
  const value = Number(line.slice(colon + 1))
  if (Number.isFinite(value)) t[key] += value
}

const round = (n) => Math.round(n * 100) / 100

// A wiring error (a satellite with no data in the merge) is distinct from a
// below-floor number: report-only suppresses the latter so the first run can
// read the numbers, but a satellite that is not being measured at all always
// fails, since it means the gate is not doing its job for that package.
let belowFloor = false
let wiringError = false
const rows = []
for (const sat of satellites) {
  const t = tally.get(sat.dir)
  // No line records at all for this satellite means its V8 never reached the
  // merge. That is a wiring bug, not a coverage level.
  if (t.LF === 0) {
    wiringError = true
    rows.push(
      `  ${sat.name.padEnd(34)} no coverage data (is packages/${sat.dir}/src wired into the merge?)`
    )
    continue
  }
  const found = { lines: t.LF, functions: t.FNF, branches: t.BRF }
  const hit = { lines: t.LH, functions: t.FNH, branches: t.BRH }
  for (const metric of ['lines', 'functions', 'branches']) {
    const min = sat.floors[metric]
    if (typeof min !== 'number') {
      // The graduation gate requires all three floors to be numbers; if one is
      // missing here, treat it as a config error rather than a free pass.
      belowFloor = true
      rows.push(`  ${sat.name.padEnd(34)} ${metric.padEnd(10)} floor not declared as a number`)
      continue
    }
    if (found[metric] === 0) {
      // No units of this kind in the merged report. There is nothing to gate,
      // and crediting 100% would be a misleading pass, so report n/a and skip.
      rows.push(
        `  ${sat.name.padEnd(34)} ${metric.padEnd(10)}    n/a   (min ${String(min).padStart(3)}%)   skip (no units)`
      )
      continue
    }
    const actual = round((hit[metric] / found[metric]) * 100)
    const ok = actual >= min
    if (!ok) belowFloor = true
    rows.push(
      `  ${sat.name.padEnd(34)} ${metric.padEnd(10)} ${String(actual).padStart(6)}%   (min ${String(min).padStart(3)}%)   ${ok ? 'ok' : 'FAIL'}`
    )
  }
}

console.log(`Per-satellite merged coverage — ${lcovFile}`)
console.log(rows.join('\n'))

if (wiringError) {
  console.error(
    '\ncheck-satellite-coverage: a satellite has no coverage data in the merge (wiring error, fails even in report-only)'
  )
  process.exit(1)
}
if (belowFloor) {
  if (reportOnly) {
    console.log('\ncheck-satellite-coverage: below floor (report-only, not failing)')
    process.exit(0)
  }
  console.error('\ncheck-satellite-coverage: a satellite is below its declared merged-coverage floor')
  process.exit(1)
}
console.log('\ncheck-satellite-coverage: passed')
