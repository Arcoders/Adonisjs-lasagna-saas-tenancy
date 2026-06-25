#!/usr/bin/env node
/**
 * Stability-label vs. version guard (audit P1-3).
 *
 * The stability page (docs/reference/stability.md) is the canonical source for what
 * each package promises: `experimental` surfaces "may change in any minor" and
 * are excluded from the semver promise, while `release candidate` / `stable`
 * surfaces freeze their API at >=1.0.0. A version string asserts the same
 * thing to npm consumers — `1.0.0` is the universal "semver-protected" signal —
 * so the two must never disagree. This script makes that agreement mechanical:
 *
 *   experimental            -> version must be 0.x (or carry a pre-release tag)
 *   release candidate/stable -> version must be >= 1.0.0
 *
 * Labels are PARSED from stability.md (the satellite table and the core
 * section header), not hard-coded, so relabeling a package without
 * re-versioning it (or vice versa) fails CI instead of shipping a lie.
 *
 * Usage: node scripts/check-stability-versions.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const STABILITY_DOC = 'docs/reference/stability.md'
const PACKAGES_DIR = 'packages'

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
  } else if (label === 'release candidate' || label === 'stable') {
    if (major < 1) {
      failures.push(
        `${manifest.name}@${version}: labeled "${label}" but versioned 0.x — bump to >=1.0.0 or demote the label`
      )
    }
  } else {
    failures.push(`${manifest.name}: unrecognized stability label "${label}" in ${STABILITY_DOC}`)
  }

  checked.push(`  ${manifest.name}@${version} — ${label}`)
}

console.log('Stability/version agreement:')
console.log(checked.join('\n'))

if (failures.length > 0) {
  console.error('\ncheck-stability-versions: FAIL')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\ncheck-stability-versions: passed')
