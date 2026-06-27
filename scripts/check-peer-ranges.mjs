#!/usr/bin/env node
// Guards the @adonisjs/queue peer in core/billing/backup: it must be (1) WIDENED
// past a single 0.x minor — a `^0.6.0` caret caps at <0.7.0, so a queue 0.7.0
// release would break every install — and (2) declared OPTIONAL, so a host that
// runs no background jobs is not forced to install it.
//
// WS-8 / adonisjs-queue-0x-peer-frozen. Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const PKGS = ['packages/core', 'packages/billing', 'packages/backup']
const DEP = '@adonisjs/queue'

/** Pure rule over a parsed package.json. */
function lint(pkg) {
  const problems = []
  const range = pkg.peerDependencies?.[DEP]
  if (!range) {
    problems.push(`no ${DEP} peerDependency`)
    return problems
  }
  // A bare 0.x caret (^0.x.y) resolves to >=0.x.y <0.(x+1).0 — capped at the next
  // 0.x minor. Require an explicitly widened range (a `||` union or an upper `<1`).
  if (/^\^0\./.test(range)) {
    problems.push(`${DEP} range "${range}" caps at the next 0.x minor; widen it (e.g. ">=0.6.0 <1")`)
  }
  if (pkg.peerDependenciesMeta?.[DEP]?.optional !== true) {
    problems.push(`${DEP} must be declared optional in peerDependenciesMeta`)
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const good = { peerDependencies: { [DEP]: '>=0.6.0 <1' }, peerDependenciesMeta: { [DEP]: { optional: true } } }
  const cappedl = { peerDependencies: { [DEP]: '^0.6.0' }, peerDependenciesMeta: { [DEP]: { optional: true } } }
  const required = { peerDependencies: { [DEP]: '>=0.6.0 <1' } }
  const failures = []
  if (lint(good).length !== 0) failures.push('good fixture flagged')
  if (lint(cappedl).length === 0) failures.push('capped-range fixture passed')
  if (lint(required).length === 0) failures.push('non-optional fixture passed')
  if (failures.length) {
    console.error('check-peer-ranges --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-peer-ranges --self-test: OK')
  process.exit(0)
}

const errors = []
for (const p of PKGS) {
  const manifest = join(p, 'package.json')
  if (!existsSync(r(manifest))) {
    errors.push(`missing ${manifest}`)
    continue
  }
  for (const problem of lint(JSON.parse(readFileSync(r(manifest), 'utf8')))) {
    errors.push(`${p}: ${problem}`)
  }
}

if (errors.length > 0) {
  console.error('check-peer-ranges: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-peer-ranges: OK (${PKGS.length} packages verified)`)
