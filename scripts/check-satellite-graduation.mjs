#!/usr/bin/env node
/**
 * Satellite graduation gate.
 *
 * A satellite may only carry the `release candidate` (or `stable`) label in
 * docs/docs/stability.md once it meets a uniform, mechanically-checkable bar.
 * This script enforces that bar so a satellite can never be relabeled to RC
 * without the artifacts that make the label honest. It complements
 * check-stability-versions.mjs (which enforces label <-> version agreement) by
 * checking the rest of the graduation gate.
 *
 * For every package under packages/ that declares a `lasagnaSatellite` manifest
 * AND is labeled `release candidate` / `stable` in stability.md, it verifies:
 *
 *   - version >= 1.0.0
 *   - an own .c8rc.json with `check-coverage: true` (a real coverage gate)
 *   - a declared `lasagnaSatellite.minMergedCoverage` floor at the graduation
 *     bar (lines >= MIN_MERGED_LINES). The numeric value is enforced by
 *     check-satellite-coverage.mjs in the coverage job (which has the merged
 *     unit+integration lcov); here we only assert it is DECLARED and at the bar,
 *     so an RC satellite can never ship without opting into the per-satellite gate.
 *   - `lasagnaSatellite.satelliteApi` is a positive integer (in the ABI net)
 *   - an `adonisjs.configure` hook (so `node ace configure <pkg>` works)
 *   - a CHANGELOG.md
 *   - a doc page at docs/docs/satellites/<manifest.name>.md
 *
 * Experimental satellites are reported but not enforced: they have not graduated.
 *
 * Usage: node scripts/check-satellite-graduation.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const STABILITY_DOC = 'docs/docs/stability.md'
const PACKAGES_DIR = 'packages'
const SATELLITE_DOCS_DIR = 'docs/docs/satellites'

// The graduation bar for per-satellite MERGED (unit+integration) line coverage.
// Kept in sync with scripts/check-satellite-coverage.mjs, which enforces the
// actual number against the merged lcov.
const MIN_MERGED_LINES = 60

const doc = readFileSync(STABILITY_DOC, 'utf8')

/** package name -> normalized stability label, parsed from the satellite table. */
const labels = new Map()
for (const m of doc.matchAll(/^\|\s*`(@[\w-]+\/[\w-]+)`\s*\|\s*([A-Za-z ]+?)\s*\|/gm)) {
  labels.set(m[1], m[2].trim().toLowerCase())
}

const failures = []
const checked = []

for (const dir of readdirSync(PACKAGES_DIR)) {
  const manifestPath = join(PACKAGES_DIR, dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (pkg.private) continue
  if (!pkg.lasagnaSatellite) continue // not a satellite (e.g. the core)

  const name = pkg.name
  const label = labels.get(name) ?? '(no label)'
  // Only satellites claiming graduation must clear the gate.
  if (label !== 'release candidate' && label !== 'stable') {
    checked.push(`  ${name} — ${label} (experimental: gate not enforced)`)
    continue
  }

  const fail = (msg) => failures.push(`${name}: ${msg}`)
  const pkgDir = join(PACKAGES_DIR, dir)

  // version >= 1.0.0
  const major = Number(String(pkg.version).split('.')[0])
  if (!(major >= 1)) fail(`labeled "${label}" but version ${pkg.version} is < 1.0.0`)

  // own coverage gate
  const c8Path = join(pkgDir, '.c8rc.json')
  if (!existsSync(c8Path)) {
    fail('missing .c8rc.json (no coverage gate)')
  } else {
    const c8 = JSON.parse(readFileSync(c8Path, 'utf8'))
    if (c8['check-coverage'] !== true) fail('.c8rc.json does not set check-coverage: true')
  }

  // declared merged-coverage floor. The numeric value is enforced by
  // scripts/check-satellite-coverage.mjs in the coverage job (which has the
  // merged lcov); here we assert it is DECLARED and at the bar, so an RC
  // satellite can never ship without opting into the per-satellite merged gate.
  const merged = pkg.lasagnaSatellite.minMergedCoverage
  if (!merged || typeof merged !== 'object') {
    fail('missing lasagnaSatellite.minMergedCoverage (no per-satellite merged coverage floor)')
  } else {
    for (const metric of ['lines', 'functions', 'branches']) {
      if (typeof merged[metric] !== 'number') {
        fail(`lasagnaSatellite.minMergedCoverage.${metric} must be a number`)
      }
    }
    if (typeof merged.lines === 'number' && merged.lines < MIN_MERGED_LINES) {
      fail(
        `lasagnaSatellite.minMergedCoverage.lines (${merged.lines}) is below the graduation bar of ${MIN_MERGED_LINES}`
      )
    }
  }

  // ABI-versioned manifest
  const api = pkg.lasagnaSatellite.satelliteApi
  if (!(Number.isInteger(api) && api > 0)) {
    fail('lasagnaSatellite.satelliteApi must be a positive integer')
  }

  // configure hook
  if (typeof pkg.adonisjs?.configure !== 'string') {
    fail('missing adonisjs.configure (no `node ace configure` hook)')
  }

  // CHANGELOG
  if (!existsSync(join(pkgDir, 'CHANGELOG.md'))) fail('missing CHANGELOG.md')

  // doc page
  const docName = pkg.lasagnaSatellite.name
  const docPath = join(SATELLITE_DOCS_DIR, `${docName}.md`)
  if (!existsSync(docPath)) fail(`missing doc page ${docPath}`)

  checked.push(`  ${name}@${pkg.version} — ${label}`)
}

console.log('Satellite graduation gate:')
console.log(checked.join('\n'))

if (failures.length > 0) {
  console.error('\ncheck-satellite-graduation: FAIL')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\ncheck-satellite-graduation: passed')
