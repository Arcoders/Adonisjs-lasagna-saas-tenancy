#!/usr/bin/env node
/**
 * Isthmus audit-coverage gate + thinness report.
 *
 * Reads the two single-source modules textually (no build needed):
 *   - packages/core/src/isthmus/registry.ts            (the guard registry)
 *   - packages/core/src/isthmus/no_silent_guard_allowlist.ts
 * then scans packages/core/src for fail-closed throw sites (the "Refus…" guard
 * idiom adjacent to a `throw new`, forward-only window, comments excluded —
 * the same detector the @architecture no_silent_guard spec pins with controls;
 * the DATA is shared, so the spec and this gate cannot disagree on entries).
 *
 * Audit-coverage Index = sites in registered-and-emitting files
 *                      / (all detected sites − allowlisted sites) × 100
 *
 * Unregistered guards lower the Index until registered or allowlisted-with-why,
 * so the floor gates something real (the naive "registered entries that emit"
 * ratio is 100% by construction — the contract spec already forces it).
 *
 * Blocking:  Index below the floor; a registry entry with empty evidence.
 * Non-blocking: entries past their nextReview date (printed for the 6-month review).
 *
 * Env seams (the coverage-gate conventions):
 *   ISTHMUS_MIN_INDEX=<n>    override the floor (default 90; ratchet: at each
 *                            release/review raise to floor(measured) − 2, never lower)
 *   ISTHMUS_REPORT_ONLY=1    measure and print, never fail (first-run seam)
 *
 * Run locally and in CI (via scripts/check.mjs): node scripts/check-isthmus.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORE = join(ROOT, 'packages/core')
const SRC = join(CORE, 'src')

const MIN_INDEX = Number(process.env.ISTHMUS_MIN_INDEX ?? 90)
const REPORT_ONLY = process.env.ISTHMUS_REPORT_ONLY === '1'

// --- Parse the registry (literal entries only, by design) --------------------

const registrySrc = readFileSync(join(SRC, 'isthmus/registry.ts'), 'utf8')
const entryRe = /\{\s*id:\s*'([^']+)'[\s\S]*?guardFile:\s*'([^']+)'[\s\S]*?nextReview:\s*'([^']+)'\s*,?\s*\}/g
const evidenceRe = /evidence:\s*\{\s*kind:\s*'([^']*)'\s*,\s*ref:\s*'([^']*)'/

const entries = []
for (const m of registrySrc.matchAll(entryRe)) {
  const block = m[0]
  const ev = block.match(evidenceRe)
  entries.push({
    id: m[1],
    guardFile: m[2],
    nextReview: m[3],
    pillar: m[1].split('.')[0],
    evidenceRef: ev ? ev[2] : '',
  })
}
if (entries.length === 0) {
  console.error('check-isthmus: FAIL — parsed 0 registry entries (regex drifted from registry.ts?)')
  process.exit(1)
}

const allowlistSrc = readFileSync(join(SRC, 'isthmus/no_silent_guard_allowlist.ts'), 'utf8')
const allowlisted = [...allowlistSrc.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1])

// --- Detect fail-closed throw sites (same shape as the architecture spec) ----

const WINDOW = 4
const isComment = (line) => {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function refusalThrowSites(src) {
  const lines = src.split('\n')
  const sites = []
  lines.forEach((line, i) => {
    if (isComment(line) || !/\bthrow new /.test(line)) return
    const window = lines.slice(i, i + WINDOW + 1).filter((l) => !isComment(l))
    if (window.some((l) => /refus/i.test(l))) sites.push(i + 1)
  })
  return sites
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) yield full
  }
}

const registeredFiles = new Set(entries.map((e) => e.guardFile))
const allowedFiles = new Set(allowlisted)

let coveredSites = 0
let allowlistedSites = 0
const uncovered = []
let totalSites = 0

for (const file of walk(SRC)) {
  const rel = relative(CORE, file).replace(/\\/g, '/')
  const src = readFileSync(file, 'utf8')
  const sites = refusalThrowSites(src)
  if (sites.length === 0) continue
  totalSites += sites.length
  if (allowedFiles.has(rel)) {
    allowlistedSites += sites.length
  } else if (registeredFiles.has(rel) && src.includes('emitIsthmusEvent(')) {
    coveredSites += sites.length
  } else {
    uncovered.push(`${rel}:${sites.join(',')}`)
  }
}

const denominator = totalSites - allowlistedSites
const index = denominator > 0 ? (coveredSites / denominator) * 100 : 100

// --- Thinness + review report -------------------------------------------------

const failures = []
for (const e of entries) {
  if (!e.evidenceRef.trim()) failures.push(`registry entry ${e.id} has empty evidence.ref`)
}

const today = new Date().toISOString().slice(0, 10)
const pastReview = entries.filter((e) => e.nextReview < today)

console.log(`check-isthmus: ${entries.length} registered guards, ${allowlisted.length} allowlisted file(s)`)
console.log(
  `check-isthmus: Audit-coverage Index = ${index.toFixed(1)}% ` +
    `(${coveredSites} covered / ${denominator} gated sites; ${allowlistedSites} allowlisted, floor ${MIN_INDEX})`
)
if (pastReview.length > 0) {
  console.log(
    `check-isthmus: NOTE — ${pastReview.length} entr${pastReview.length === 1 ? 'y is' : 'ies are'} past nextReview (6-month review due): ` +
      pastReview.map((e) => `${e.id} (${e.nextReview})`).join(', ')
  )
}

if (index < MIN_INDEX) {
  failures.push(
    `Audit-coverage Index ${index.toFixed(1)}% is below the floor ${MIN_INDEX}%. Uncovered sites:\n` +
      uncovered.map((u) => `  - ${u}`).join('\n') +
      '\nRegister the guard in ISTHMUS_REGISTRY (and emit before the throw), or allowlist it with a written reason.'
  )
}

if (failures.length > 0) {
  const label = REPORT_ONLY ? 'REPORT-ONLY (would fail)' : 'FAIL'
  console.error(`\ncheck-isthmus: ${label} —\n${failures.map((f) => `- ${f}`).join('\n')}`)
  process.exit(REPORT_ONLY ? 0 : 1)
}
console.log('check-isthmus: OK')
