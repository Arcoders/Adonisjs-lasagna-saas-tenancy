#!/usr/bin/env node
// Guards the manual-fallback publish workflow in BOTH directions:
//
//  1. It must publish EVERY non-private workspace package. The list in
//     publish.yml was hand-maintained and silently omitted reporting +
//     websockets, so a `changeset publish` fallback would never ship them.
//  2. It must publish NOTHING ELSE. The script runs under `set -euo pipefail`,
//     so a single bad entry aborts the release mid-run, leaving a partial,
//     inconsistent set of versions on npm. Two entries were exactly that: the
//     deleted `packages/crypto` (ENOENT reading its package.json) and the
//     `private: true` admin + websockets packages (npm refuses with EPRIVATE).
//
// WS-8 / publish-fallback-missing-satellites. Ships `--self-test`.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const PUBLISH_YML = '.github/workflows/publish.yml'
const PACKAGES_DIR = 'packages'

/** Every `publish_pkg "packages/<dir>"` call in the workflow, in order. */
function publishedDirs(publishText) {
  return [...publishText.matchAll(/^\s*publish_pkg\s+"packages\/([\w-]+)"/gm)].map((m) => m[1])
}

/**
 * Pure rule. `packages` is every non-private workspace; `allDirs` is every
 * directory under packages/ (so a call naming a deleted package is caught too).
 */
function lint(publishText, packages, allDirs) {
  const called = publishedDirs(publishText)
  const publishable = new Set(packages.map((p) => p.dir))
  const problems = []

  for (const p of packages) {
    if (!called.includes(p.dir)) {
      problems.push(`${p.name} is a non-private package but not referenced in ${PUBLISH_YML}`)
    }
  }
  for (const dir of called) {
    if (publishable.has(dir)) continue
    problems.push(
      allDirs.includes(dir)
        ? `packages/${dir} is private but publish.yml calls publish_pkg on it — npm fails with EPRIVATE and aborts the release`
        : `packages/${dir} does not exist but publish.yml calls publish_pkg on it — reading its package.json throws and aborts the release`
    )
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const pkgs = [
    { dir: 'core', name: '@x/core' },
    { dir: 'reporting', name: '@x/reporting' },
  ]
  const allDirs = ['core', 'reporting', 'admin']
  const good = 'publish_pkg "packages/core"\npublish_pkg "packages/reporting"'
  const failures = []

  if (lint(good, pkgs, allDirs).length !== 0) failures.push('good fixture flagged')
  if (lint('publish_pkg "packages/core"', pkgs, allDirs).length !== 1)
    failures.push('missing fixture not flagged')
  if (lint(`${good}\npublish_pkg "packages/admin"`, pkgs, allDirs).length !== 1)
    failures.push('private-package fixture not flagged')
  if (lint(`${good}\npublish_pkg "packages/crypto"`, pkgs, allDirs).length !== 1)
    failures.push('deleted-package fixture not flagged')

  if (failures.length) {
    console.error('check-publish-coverage --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-publish-coverage --self-test: OK')
  process.exit(0)
}

const errors = []
if (!existsSync(r(PUBLISH_YML))) {
  errors.push(`missing ${PUBLISH_YML}`)
} else {
  const publishText = readFileSync(r(PUBLISH_YML), 'utf8')
  const packages = []
  const allDirs = []
  for (const dir of readdirSync(r(PACKAGES_DIR))) {
    const manifest = join(PACKAGES_DIR, dir, 'package.json')
    if (!existsSync(r(manifest))) continue
    allDirs.push(dir)
    const pkg = JSON.parse(readFileSync(r(manifest), 'utf8'))
    if (pkg.private) continue
    packages.push({ dir, name: pkg.name })
  }
  errors.push(...lint(publishText, packages, allDirs))
}

if (errors.length > 0) {
  console.error('check-publish-coverage: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log('check-publish-coverage: OK')
