#!/usr/bin/env node
// Guards that the tenant lifecycle status space stays coherent across the places that
// re-declare it OUTSIDE the type system (and so cannot be caught by tsc). `TenantStatus`
// is derived from the `TENANT_STATUSES` tuple (the single source of truth); this asserts
// that tuple is set-equal to:
//   - the `tenant:exec --status` help string token list (a literal, pinned here);
//   - the `docs/architecture.md` status enum (a literal, must stay byte-matched);
//   - the composite `TENANT_STATE_MATRIX` status keys (every status is a reachable state).
// A new status added to the tuple but forgotten in any of these fails CI. The compile
// -time floor (tenantLifecycleDisposition + assertNever) covers the code paths; this
// covers the non-type-derived declarations. Ships `--self-test`.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

/** The `TENANT_STATUSES = ['a','b',...]` tuple in contracts.ts. */
function parseTuple(src) {
  const m = src.match(/TENANT_STATUSES\s*=\s*\[([^\]]+)\]/)
  if (!m) return null
  return [...m[1].matchAll(/['"]([a-z_]+)['"]/g)].map((x) => x[1])
}

/** The `--status` help string: `... (active|provisioning|suspended|failed|deleted). ...`. */
function parseExecHelp(src) {
  const m = src.match(/Filter by status \(([a-z|]+)\)/)
  if (!m) return null
  return m[1].split('|').filter(Boolean)
}

/** The docs enum: The status enum is `provisioning | active | suspended | failed | deleted`. */
function parseDocsEnum(src) {
  const m = src.match(/status enum is `([a-z |]+)`/)
  if (!m) return null
  return m[1].split('|').map((s) => s.trim()).filter(Boolean)
}

/** Every distinct `status: '<value>'` literal in the state matrix. */
function parseMatrix(src) {
  const set = new Set([...src.matchAll(/status:\s*['"]([a-z_]+)['"]/g)].map((x) => x[1]))
  return [...set]
}

const norm = (list) => [...new Set(list ?? [])].sort()

/** Pure rule: compare each named source's status set against the canonical tuple. */
function diffStatusSets(canonical, sources) {
  const want = norm(canonical)
  const problems = []
  for (const [name, list] of Object.entries(sources)) {
    if (list === null) {
      problems.push(`${name}: could not locate the status list to compare`)
      continue
    }
    const got = norm(list)
    const missing = want.filter((s) => !got.includes(s))
    const extra = got.filter((s) => !want.includes(s))
    if (missing.length) problems.push(`${name}: missing ${missing.join(', ')}`)
    if (extra.length) problems.push(`${name}: has unknown status ${extra.join(', ')}`)
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const failures = []
  const canonical = ['provisioning', 'active', 'suspended', 'failed', 'deleted']

  // coherent
  if (
    diffStatusSets(canonical, {
      exec: ['active', 'provisioning', 'suspended', 'failed', 'deleted'],
      docs: ['deleted', 'failed', 'suspended', 'active', 'provisioning'],
      matrix: canonical,
    }).length !== 0
  ) {
    failures.push('coherent sets flagged')
  }
  // a source missing a status
  if (diffStatusSets(canonical, { x: ['active', 'provisioning', 'suspended', 'failed'] }).length === 0) {
    failures.push('missing status not caught')
  }
  // a source with an unknown status
  if (diffStatusSets(canonical, { x: [...canonical, 'zombie'] }).length === 0) {
    failures.push('unknown status not caught')
  }
  // parsers
  if (parseTuple(`export const TENANT_STATUSES = ['a','b'] as const`)?.join(',') !== 'a,b') {
    failures.push('parseTuple broken')
  }
  if (parseExecHelp('Filter by status (active|failed). Repeatable')?.join(',') !== 'active,failed') {
    failures.push('parseExecHelp broken')
  }
  if (parseDocsEnum('The status enum is `active | failed`.')?.join(',') !== 'active,failed') {
    failures.push('parseDocsEnum broken')
  }

  if (failures.length) {
    console.error('check-tenant-statuses --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-tenant-statuses --self-test: OK')
  process.exit(0)
}

const canonical = parseTuple(readFileSync(r('packages/core/src/types/contracts.ts'), 'utf8'))
if (!canonical) {
  console.error('check-tenant-statuses: FAIL — could not parse TENANT_STATUSES from contracts.ts')
  process.exit(1)
}

const problems = diffStatusSets(canonical, {
  'tenant:exec help string': parseExecHelp(
    readFileSync(r('packages/core/src/commands/tenant_exec.ts'), 'utf8')
  ),
  'docs/architecture.md enum': parseDocsEnum(readFileSync(r('docs/architecture.md'), 'utf8')),
  TENANT_STATE_MATRIX: parseMatrix(
    readFileSync(r('packages/core/src/services/doctor/tenant_state_matrix.ts'), 'utf8')
  ),
})

if (problems.length > 0) {
  console.error('check-tenant-statuses: FAIL')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`check-tenant-statuses: OK (${canonical.length} statuses, 3 source(s) coherent)`)
