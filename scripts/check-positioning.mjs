#!/usr/bin/env node
/**
 * Positioning guard.
 *
 * Two firm product decisions: Lasagna supports PostgreSQL ONLY and AdonisJS
 * ONLY. Both are deliberate, permanent product decisions, not deferrals. The
 * docs used to frame MySQL as a "future / planned / on-the-roadmap opt-in
 * satellite" and that framing now directly contradicts the decision. The
 * VitePress dead-link gate and the docs-integrity specs can't see prose meaning,
 * so a stale "MySQL is coming" sentence (or a new "framework-agnostic" promise)
 * would ship silently.
 *
 * This guard scans every tracked text file and fails if it finds MySQL/MariaDB
 * framed as a future direction, or any copy implying framework portability. The
 * patterns are deliberately tight and line-scoped (`[^.\n]` never crosses a
 * sentence or a newline) so the correct "PostgreSQL-only by design" copy — which
 * still legitimately names MySQL on the comparison page and in the isolation-
 * driver seam docs — does not trip them. State the decision positively ("by
 * design", "not supported", "if you need MySQL today, use stancl") and keep any
 * "roadmap"/"future" word off the same line as a MySQL mention.
 *
 * Run it locally and in CI: `node scripts/check-positioning.mjs`.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SCAN_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.vue',
  '.edge',
  '.stub',
])

const SKIP_FILES = new Set([
  'package-lock.json', // huge lockfile; dependency names, not authored positioning
  basename(fileURLToPath(import.meta.url)), // this guard spells out the patterns it hunts for
])

// Each rule is { re, why }. `re` runs per-line. Keep windows small so a banned
// keyword only fires when it sits right beside the subject, never a sentence away.
const RULES = [
  {
    re: /\b(mysql|mariadb)\b[^.\n]{0,60}\b(roadmap|planned|upcoming|when it lands|will land|coming soon)\b/i,
    why: 'MySQL/MariaDB framed as a future direction (PostgreSQL-only is by design)',
  },
  {
    re: /\b(roadmap|planned|upcoming|when it lands|will land|coming soon)\b[^.\n]{0,60}\b(mysql|mariadb)\b/i,
    why: 'MySQL/MariaDB framed as a future direction (PostgreSQL-only is by design)',
  },
  {
    re: /\bfuture\b[^.\n]{0,30}\b(mysql|mariadb)\b/i,
    why: '"future" MySQL/MariaDB (PostgreSQL-only is by design)',
  },
  {
    re: /\b(mysql|mariadb)\b[^.\n]{0,30}\bfuture\b/i,
    why: 'MySQL/MariaDB tied to "future" (PostgreSQL-only is by design)',
  },
  {
    re: /\bfuture (opt-in )?(mysql |mariadb )?satellite\b/i,
    why: 'a "future satellite" promise (the DB decision is permanent)',
  },
  {
    re: /framework[- ]agnostic/i,
    why: 'framework-agnostic framing (AdonisJS-only is by design)',
  },
  {
    re: /@lasagna\/kernel\b/i,
    why: 'a kernel-extraction reference (AdonisJS-only is by design)',
  },
  {
    re: /\b(express|nestjs|fastify|koa)[- ]adapters?\b/i,
    why: 'a non-AdonisJS framework adapter (AdonisJS-only is by design)',
  },
]

// Only validate TRACKED files (what actually ships): `git ls-files` respects
// .gitignore, so build output, coverage and node_modules never enter the scan.
const tracked = execSync('git ls-files -z', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

const failures = []
let scanned = 0

for (const rel of tracked) {
  if (SKIP_FILES.has(basename(rel))) continue
  if (!SCAN_EXT.has(extname(rel))) continue
  // `git ls-files` reads the index, so a file deleted in the working tree but not
  // yet staged is still listed. Skip it: it ships as deleted, and reading it would
  // crash the guard with ENOENT instead of reporting anything.
  if (!existsSync(join(ROOT, rel))) continue

  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
  scanned++
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        failures.push(`${rel}:${i + 1}  ${rule.why}\n      ${line.trim()}`)
      }
    }
  })
}

console.log(`check-positioning: scanned ${scanned} files`)
if (failures.length > 0) {
  console.error(`\ncheck-positioning: FAIL — ${failures.length} line(s) contradict the product decisions:\n`)
  for (const f of failures) console.error('  - ' + f)
  console.error(
    '\nLasagna is PostgreSQL-only and AdonisJS-only, by design — not a deferral. Reword these' +
      '\nto state the decision positively ("by design", "not supported", "if you need MySQL today,' +
      '\nuse stancl") and keep "roadmap"/"future" off the same line as a MySQL mention. This guard' +
      '\nruns in CI; run it locally with `node scripts/check-positioning.mjs` before pushing.'
  )
  process.exit(1)
}
console.log('check-positioning: passed — docs match the PostgreSQL-only / AdonisJS-only decisions.')
