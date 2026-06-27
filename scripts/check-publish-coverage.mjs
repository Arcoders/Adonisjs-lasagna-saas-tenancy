#!/usr/bin/env node
// Guards that the manual-fallback publish workflow publishes EVERY non-private
// workspace package. The list in publish.yml was hand-maintained and silently
// omitted reporting + websockets, so a `changeset publish` fallback would never
// ship them.
//
// WS-8 / publish-fallback-missing-satellites. Ships `--self-test`.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const PUBLISH_YML = '.github/workflows/publish.yml'
const PACKAGES_DIR = 'packages'

/** Pure rule: which non-private packages are not referenced in the workflow text. */
function lint(publishText, packages) {
  return packages.filter((p) => !publishText.includes(`packages/${p.dir}`)).map((p) => p.name)
}

if (process.argv.includes('--self-test')) {
  const pkgs = [{ dir: 'core', name: '@x/core' }, { dir: 'reporting', name: '@x/reporting' }]
  const failures = []
  if (lint('publish_pkg "packages/core"\npublish_pkg "packages/reporting"', pkgs).length !== 0)
    failures.push('good fixture flagged')
  if (lint('publish_pkg "packages/core"', pkgs).length !== 1) failures.push('missing fixture not flagged')
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
  for (const dir of readdirSync(r(PACKAGES_DIR))) {
    const manifest = join(PACKAGES_DIR, dir, 'package.json')
    if (!existsSync(r(manifest))) continue
    const pkg = JSON.parse(readFileSync(r(manifest), 'utf8'))
    if (pkg.private) continue
    packages.push({ dir, name: pkg.name })
  }
  for (const name of lint(publishText, packages)) {
    errors.push(`${name} is a non-private package but not referenced in ${PUBLISH_YML}`)
  }
}

if (errors.length > 0) {
  console.error('check-publish-coverage: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log('check-publish-coverage: OK')
