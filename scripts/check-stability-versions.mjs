#!/usr/bin/env node
/**
 * Stability-label vs. version guard (audit P1-3).
 *
 * The stability page (docs/reference/stability.md) is the canonical source for what
 * each package promises. The label describes MATURITY; the version describes the
 * SEMVER PROMISE. They are related but not the same axis, and the rule below only
 * forbids the combinations that are a lie:
 *
 *   experimental      -> version must be 0.x (or carry a pre-release tag).
 *                        Claiming "may change in any minor" while shipping 1.x
 *                        tells npm consumers the opposite.
 *   release candidate -> any version. A 0.x RC says "we think the API is nearly
 *                        right, and semver still promises you nothing" — strictly
 *                        more conservative than a 1.x RC, so it cannot mislead.
 *   stable            -> version must be >= 1.0.0. This is the only claim that
 *                        REQUIRES the semver-protected signal, and the one that
 *                        must be earned.
 *
 * Labels are PARSED from stability.md (the satellite table and the core
 * section header), not hard-coded, so relabeling a package without
 * re-versioning it (or vice versa) fails CI instead of shipping a lie.
 *
 * It also asserts each non-private package's README stability BADGE mirrors that
 * same matrix label. stability.md promises "the per-package READMEs and the npm
 * pages mirror it", but nothing enforced it — four satellite READMEs silently
 * drifted to an `experimental` badge while the matrix said `release candidate`
 * and CI stayed green. This closes that hole.
 *
 * Usage: node scripts/check-stability-versions.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const STABILITY_DOC = 'docs/reference/stability.md'
const PACKAGES_DIR = 'packages'

// Prose-drift pass (WS-10 / stability-prose-contradicts-matrix). These pages must
// agree with the matrix about what the satellite PACKAGES promise. The matrix now
// labels all five experimental and ships them at 0.x, so the banned assertion is
// the inverse of what it once was: prose must not promote them to release
// candidate or stable. The word itself is not banned — the CORE is a release
// candidate, and saying so is true.
const PROSE_PAGES = [
  'docs/reference/stability.md',
  '.github/SECURITY.md',
  'docs/reference/faq.md',
  'docs/reference/production-checklist.md',
  'docs/reference/known-limitations.md',
  'docs/reference/roadmap.md',
]
const BANNED_PROSE = [
  /satellites?\s+(?:are|stay|remain)\s+[*`]*(?:release candidate|stable)/i,
  /satellites?\s+(?:have\s+)?graduated\s+(?:to\s+)?[*`]*(?:release candidate|stable)/i,
]

/** Pure: the banned matches in one page's text (for the prose pass + self-test). */
function proseDrift(text) {
  return BANNED_PROSE.map((re) => text.match(re)).filter(Boolean).map((m) => m[0])
}

if (process.argv.includes('--self-test')) {
  const bad = 'The satellites are **release candidate** and the core is stable.'
  const good =
    'The satellite packages are experimental; the isolation core is a release candidate.'
  const problems = []
  if (proseDrift(bad).length === 0) problems.push('bad fixture (satellites promoted to RC) not flagged')
  if (proseDrift(good).length !== 0) problems.push('good fixture (core is RC) flagged')
  if (problems.length) {
    console.error('check-stability-versions --self-test: FAIL')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log('check-stability-versions --self-test: OK')
  process.exit(0)
}

const doc = readFileSync(STABILITY_DOC, 'utf8')

/** @type {Map<string, string>} package name -> normalized label */
const labels = new Map()

// Satellite table rows: | `@adonisjs-lasagna/admin` | Experimental | ... |
for (const match of doc.matchAll(/^\|\s*`(@[\w-]+\/[\w-]+)`\s*\|\s*([A-Za-z ]+?)\s*\|/gm)) {
  labels.set(match[1], match[2].trim().toLowerCase())
}

// Core section header: "Everything here is **release candidate** unless noted."
const coreLabel = doc.match(/Everything here is \*\*(stable|release candidate|experimental)\*\*/i)
if (coreLabel) labels.set('@adonisjs-lasagna/saas-tenancy', coreLabel[1].toLowerCase())

const failures = []
const checked = []

for (const dir of readdirSync(PACKAGES_DIR)) {
  const manifestPath = join(PACKAGES_DIR, dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.private) continue

  const label = labels.get(manifest.name)
  if (!label) {
    failures.push(
      `${manifest.name}: no stability label found in ${STABILITY_DOC} — every publishable package needs a row there`
    )
    continue
  }

  const version = String(manifest.version)
  const major = Number(version.split('.')[0])
  const hasPrereleaseTag = version.includes('-')

  if (label === 'experimental') {
    if (major >= 1 && !hasPrereleaseTag) {
      failures.push(
        `${manifest.name}@${version}: labeled "experimental" (no semver promise) but versioned >=1.0.0 — ` +
          `use 0.x or a pre-release tag, or promote the label`
      )
    }
  } else if (label === 'stable') {
    if (major < 1) {
      failures.push(
        `${manifest.name}@${version}: labeled "stable" but versioned 0.x — bump to >=1.0.0 or demote the label`
      )
    }
  } else if (label !== 'release candidate') {
    // A release candidate may sit at any version: 0.x is the more conservative
    // pairing, and forcing it to >=1.0.0 would only inflate the number.
    failures.push(`${manifest.name}: unrecognized stability label "${label}" in ${STABILITY_DOC}`)
  }

  // The README's stability badge must mirror the matrix label. The badge is a
  // shields token of the form `stability-<label>-<color>`, where the label has
  // its spaces written as underscores (e.g. `release_candidate`).
  if (label === 'experimental' || label === 'release candidate' || label === 'stable') {
    const readmePath = join(PACKAGES_DIR, dir, 'README.md')
    if (existsSync(readmePath)) {
      const expected = label.replace(/ /g, '_')
      const badge = readFileSync(readmePath, 'utf8').match(/stability-(experimental|release_candidate|stable)-/)
      if (!badge) {
        failures.push(
          `${manifest.name}: README has no stability badge — it must mirror the "${label}" matrix ` +
            `label (add a shields \`stability-${expected}\` badge)`
        )
      } else if (badge[1] !== expected) {
        failures.push(
          `${manifest.name}: README badges "${badge[1].replace(/_/g, ' ')}" but ${STABILITY_DOC} says ` +
            `"${label}" — update the README badge to \`stability-${expected}\``
        )
      }
    }
  }

  checked.push(`  ${manifest.name}@${version} — ${label}`)
}

// Prose-drift pass: catch pages that call the satellite packages experimental.
for (const page of PROSE_PAGES) {
  if (!existsSync(page)) {
    failures.push(`stability prose: missing ${page}`)
    continue
  }
  for (const hit of proseDrift(readFileSync(page, 'utf8'))) {
    failures.push(
      `stability prose drift in ${page}: "${hit}" — the satellite PACKAGES are release ` +
        `candidate; only in-core FEATURES are experimental`
    )
  }
}

console.log('Stability/version agreement:')
console.log(checked.join('\n'))

if (failures.length > 0) {
  console.error('\ncheck-stability-versions: FAIL')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\ncheck-stability-versions: passed')
