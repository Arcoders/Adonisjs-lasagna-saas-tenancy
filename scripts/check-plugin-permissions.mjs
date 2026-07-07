#!/usr/bin/env node
// Guards that a satellite's DECLARED plugin permissions stay coherent between the
// two places they live: the `definePlugin({ permissions: [...] })` spec in the
// provider source, and `package.json#lasagnaSatellite.permissions` (the wire form
// `configure` shows the operator for consent — S1). If they drift, the operator
// consents to one set while the code declares another. Neither side may declare a
// permission the other omits.
//
// The spec side is a set of `permission.*()` builder calls; this maps each to its
// canonical wire form and compares (order-insensitive, and model-order-insensitive
// inside a `data_change:` list) against the manifest array. A satellite that
// declares no permissions in either place is trivially coherent.
//
// plugin-platform Lote S / S1. Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

/** Satellites that ship a provider (same set as check-abi-boot-assertion). */
const PROVIDERS = [
  { key: 'billing', provider: 'packages/billing/providers/billing_provider.ts', pkg: 'packages/billing/package.json' },
  { key: 'backup', provider: 'packages/backup/providers/backup_provider.ts', pkg: 'packages/backup/package.json' },
  { key: 'reporting', provider: 'packages/reporting/providers/reporting_provider.ts', pkg: 'packages/reporting/package.json' },
  { key: 'websockets', provider: 'packages/websockets/providers/websockets_provider.ts', pkg: 'packages/websockets/package.json' },
  { key: 'ai', provider: 'packages/ai/providers/ai_provider.ts', pkg: 'packages/ai/package.json' },
]

// `permission.<kind>(<args>)` — `\b` before `permission` so `somePermission.x()`
// does not match. Args are simple string literals for `dataChange`.
const PERMISSION_CALL_RE = /\bpermission\.(\w+)\s*\(([^)]*)\)/g

/** The wire form each `permission.*()` builder call produces. */
function specPermissions(src) {
  const out = []
  for (const m of src.matchAll(PERMISSION_CALL_RE)) {
    const kind = m[1]
    if (kind === 'scheduler') out.push('scheduler')
    else if (kind === 'networkExternal') out.push('network:external')
    else if (kind === 'dbWrite') out.push('db:write')
    else if (kind === 'dataChange') {
      const models = [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
      out.push(`data_change:${models.join(',')}`)
    }
    // any other `permission.x()` is not a permission builder — ignore it
  }
  return out
}

/** Canonicalize one wire string (sort the models inside a data_change list). */
function normalize(wire) {
  if (wire.startsWith('data_change:')) {
    const models = wire.slice('data_change:'.length).split(',').filter(Boolean).sort()
    return `data_change:${models.join(',')}`
  }
  return wire
}

/** A normalized, de-duplicated, sorted set of wire strings. */
function normSet(list) {
  return [...new Set((list ?? []).map(normalize))].sort()
}

/** Pure rule: given provider source + the manifest permissions array, return problems. */
function lint(providerSrc, manifestPermissions) {
  const spec = normSet(specPermissions(providerSrc))
  const manifest = normSet(Array.isArray(manifestPermissions) ? manifestPermissions : [])
  const problems = []
  const onlySpec = spec.filter((p) => !manifest.includes(p))
  const onlyManifest = manifest.filter((p) => !spec.includes(p))
  if (onlySpec.length > 0) {
    problems.push(
      `declared in definePlugin({ permissions }) but not in ` +
        `package.json#lasagnaSatellite.permissions: ${onlySpec.join(', ')}`
    )
  }
  if (onlyManifest.length > 0) {
    problems.push(
      `declared in package.json#lasagnaSatellite.permissions but not in ` +
        `definePlugin({ permissions }): ${onlyManifest.join(', ')}`
    )
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const failures = []
  const spec = (calls) => `export default definePlugin({ name: 'x', permissions: [${calls}] })`

  // coherent
  if (lint(spec('permission.scheduler()'), ['scheduler']).length !== 0) {
    failures.push('coherent scheduler flagged')
  }
  // both empty
  if (lint("export default definePlugin({ name: 'x' })", undefined).length !== 0) {
    failures.push('empty/empty flagged')
  }
  // drift: spec has it, manifest missing
  if (lint(spec('permission.dbWrite()'), []).length === 0) {
    failures.push('spec>manifest drift passed')
  }
  // drift: manifest has it, spec missing
  if (lint("export default definePlugin({ name: 'x' })", ['db:write']).length === 0) {
    failures.push('manifest>spec drift passed')
  }
  // data_change model order-insensitive
  if (
    lint(spec("permission.dataChange('users', 'orders')"), ['data_change:orders,users']).length !==
    0
  ) {
    failures.push('data_change model order flagged')
  }
  // a non-permission `permission.` is ignored (no false positive)
  if (lint('const x = permission.whatever()', undefined).length !== 0) {
    failures.push('unknown builder produced a phantom permission')
  }

  if (failures.length) {
    console.error('check-plugin-permissions --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-plugin-permissions --self-test: OK')
  process.exit(0)
}

const errors = []
let verified = 0
for (const s of PROVIDERS) {
  if (!existsSync(r(s.provider)) || !existsSync(r(s.pkg))) continue // covered by check-abi-boot
  const pkg = JSON.parse(readFileSync(r(s.pkg), 'utf8'))
  const manifestPermissions = pkg?.lasagnaSatellite?.permissions
  for (const p of lint(readFileSync(r(s.provider), 'utf8'), manifestPermissions)) {
    errors.push(`${s.key}: ${p}`)
  }
  verified++
}

if (errors.length > 0) {
  console.error('check-plugin-permissions: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-plugin-permissions: OK (${verified} provider(s) verified)`)
