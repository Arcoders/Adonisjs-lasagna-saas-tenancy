#!/usr/bin/env node
/**
 * Production dependency audit gate.
 *
 * Replaces a bare `npm audit --omit=dev --audit-level=moderate` so we can
 * allowlist a *specific*, reviewed advisory by GHSA id while still failing on
 * every other moderate-or-higher advisory in the production tree. (npm audit has
 * no native per-advisory ignore.) Same intent as the old gate, protect what
 * ships to consumers, implemented like the repo's other gate scripts
 * (`coverage-gate.mjs`, `check-stability-versions.mjs`).
 *
 * Usage: node scripts/audit-gate.mjs
 */
import { spawnSync } from 'node:child_process'

const THRESHOLD = 'moderate'
const LEVELS = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 }
const minLevel = LEVELS[THRESHOLD]

/**
 * Advisories we have reviewed and accept, keyed by GHSA id. Keep each entry
 * justified and time-bound. Drop it the moment an in-range fix exists.
 */
const ALLOWLIST = new Map([
  [
    'GHSA-p6gq-j5cr-w38f',
    'nodemailer raw-option file-read / SSRF. Reaches the tree ONLY through the ' +
      'private `examples/api` demo (via @adonisjs/mail, then nodemailer); the published ' +
      'packages declare @adonisjs/mail as an optional PEER dep, so nothing ships ' +
      'it to consumers. No in-range fix: the patch is nodemailer >= 9.0.1 but ' +
      '@adonisjs/mail@10.3.0 still pins nodemailer ^8.0.7. Remove this entry once ' +
      '@adonisjs/mail ships a release on nodemailer >= 9.0.1.',
  ],
])

// Args are a fixed, trusted array. `shell` is needed on Windows to launch
// `npm.cmd` (Node refuses to spawn .cmd without a shell); the Linux CI path runs
// without a shell. No user input is concatenated, so there is no injection surface.
const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 64 * 1024 * 1024,
})

if (!result.stdout) {
  console.error('audit-gate: `npm audit` produced no output.')
  if (result.stderr) console.error(result.stderr)
  process.exit(1)
}

let report
try {
  report = JSON.parse(result.stdout)
} catch {
  console.error('audit-gate: could not parse `npm audit --json` output:')
  console.error(result.stdout.slice(0, 2000))
  process.exit(1)
}

const blocking = []
const ignored = new Map() // ghsa -> { title, severity }

for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object') continue // string `via` is just propagation
    if ((LEVELS[via.severity] ?? 0) < minLevel) continue
    const ghsa = /GHSA-[0-9a-z-]+/i.exec(via.url ?? '')?.[0]
    const id = ghsa ?? via.url ?? via.title ?? `${pkg}:unknown`
    if (ghsa && ALLOWLIST.has(ghsa)) {
      ignored.set(ghsa, { title: via.title, severity: via.severity })
    } else {
      blocking.push({ pkg, id, severity: via.severity, title: via.title })
    }
  }
}

if (ignored.size > 0) {
  console.log('audit-gate: ignoring reviewed advisories (>= moderate):')
  for (const [ghsa, info] of ignored) {
    console.log(`  - ${ghsa} (${info.severity}) ${info.title ?? ''}`)
    console.log(`    reason: ${ALLOWLIST.get(ghsa)}`)
  }
}

if (blocking.length > 0) {
  console.error(`\naudit-gate: FAIL, ${blocking.length} unallowlisted advisory(ies) >= ${THRESHOLD}:`)
  // Dedupe by id for a tidy list.
  const seen = new Set()
  for (const b of blocking) {
    if (seen.has(b.id)) continue
    seen.add(b.id)
    console.error(`  - ${b.id} (${b.severity}) in ${b.pkg}: ${b.title ?? ''}`)
  }
  console.error('\nRun `npm audit --omit=dev` for the full report.')
  process.exit(1)
}

console.log(`\naudit-gate: passed (no unallowlisted production advisories >= ${THRESHOLD}).`)
