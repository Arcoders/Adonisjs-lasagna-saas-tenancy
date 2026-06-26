#!/usr/bin/env node
/**
 * README structural-count guard.
 *
 * The core + root READMEs advertise three structural counts that drift when the
 * code changes but the prose doesn't, and nothing re-derived them — so "Ten
 * built-in checks" (real: 9), "36 endpoints" (real: 39), and "25 typed events"
 * (real: 28) all shipped stale within days of release. This pins each number to
 * its source of truth, so a code change forces a README update (or vice versa).
 *
 * Fast-drifting counts (test totals) are deliberately NOT pinned here — those are
 * softened to non-numeric prose instead. Only stable structural counts live here.
 *
 * Run locally and in CI: node scripts/check-readme-counts.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const READMES = ['README.md', 'packages/core/README.md']

// prettier-ignore
const WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty']
const wordToNum = (w) => WORDS.indexOf(String(w).toLowerCase())

const failures = []

// --- Source-of-truth counts -------------------------------------------------

// 1) Doctor built-in checks: entries in the `builtInChecks` array (NOT a directory
//    listing — `backup_recency` moved to the backup package and `metrics_freshness`
//    is opt-in, so both are excluded from the array on purpose).
const checksIdx = readFileSync(
  join(ROOT, 'packages/core/src/services/doctor/checks/index.ts'),
  'utf8'
)
const arrMatch = checksIdx.match(/export const builtInChecks[^=]*=\s*\[([\s\S]*?)\]/)
const arrBody = arrMatch ? arrMatch[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '') : ''
const doctorCount = arrBody
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean).length

// 2) Admin REST endpoints: router.<verb>(...) registrations in the routes module.
// Strip comments first so a commented-out or documented route can't inflate the count.
const adminRoutes = readFileSync(join(ROOT, 'packages/admin/src/routes.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
const endpointCount = (adminRoutes.match(/\brouter\.(get|post|put|patch|delete)\(/g) || []).length

// 3) Typed events: core default-export classes + billing event files.
const eventsIdx = readFileSync(join(ROOT, 'packages/core/src/events/index.ts'), 'utf8')
const coreEvents = (eventsIdx.match(/^export \{ default as /gm) || []).length
const billingEventsDir = join(ROOT, 'packages/billing/src/events/billing')
const billingEvents = existsSync(billingEventsDir)
  ? readdirSync(billingEventsDir).filter(
      (f) => f.endsWith('.ts') && f !== 'index.ts' && !f.endsWith('.spec.ts')
    ).length
  : 0
const totalEvents = coreEvents + billingEvents

// --- Assert each README mirrors the counts ----------------------------------

for (const rel of READMES) {
  const text = readFileSync(join(ROOT, rel), 'utf8')

  const doctor = text.match(/(\w+) built-in checks/)
  if (!doctor) {
    failures.push(`${rel}: could not find the "<N> built-in checks" doctor claim`)
  } else if (wordToNum(doctor[1]) !== doctorCount) {
    failures.push(
      `${rel}: doctor says "${doctor[1]} built-in checks" but builtInChecks has ${doctorCount} ` +
        `(expected "${WORDS[doctorCount] ?? doctorCount}")`
    )
  }

  const endpoints = text.match(/(\d+) endpoints/)
  if (!endpoints) {
    failures.push(`${rel}: could not find the "<N> endpoints" admin claim`)
  } else if (Number(endpoints[1]) !== endpointCount) {
    failures.push(
      `${rel}: admin says "${endpoints[1]} endpoints" but routes.ts registers ${endpointCount}`
    )
  }

  const typed = text.match(/(\d+) typed events/)
  if (!typed) {
    failures.push(`${rel}: could not find the "<N> typed events" claim`)
  } else if (Number(typed[1]) !== totalEvents) {
    failures.push(
      `${rel}: says "${typed[1]} typed events" but code has ${totalEvents} ` +
        `(${coreEvents} core + ${billingEvents} billing)`
    )
  }

  const breakdown = text.match(/(\d+) core[^+]*\+\s*(\d+) billing/)
  if (!breakdown) {
    failures.push(`${rel}: could not find the "<N> core ... + <N> billing" events breakdown`)
  } else if (Number(breakdown[1]) !== coreEvents || Number(breakdown[2]) !== billingEvents) {
    failures.push(
      `${rel}: events breakdown says "${breakdown[1]} core + ${breakdown[2]} billing" but code has ` +
        `${coreEvents} core + ${billingEvents} billing`
    )
  }
}

console.log('check-readme-counts: source-of-truth counts')
console.log(`  doctor built-in checks: ${doctorCount}`)
console.log(`  admin endpoints:        ${endpointCount}`)
console.log(`  typed events:           ${totalEvents} (${coreEvents} core + ${billingEvents} billing)`)

if (failures.length > 0) {
  console.error('\ncheck-readme-counts: FAIL\n')
  for (const f of failures) console.error('  - ' + f)
  console.error('\nUpdate the core + root README counts to match the code (or vice versa).')
  process.exit(1)
}
console.log('\ncheck-readme-counts: passed — README structural counts match the code.')
