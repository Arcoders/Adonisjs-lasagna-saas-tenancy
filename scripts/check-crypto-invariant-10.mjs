#!/usr/bin/env node
// check-crypto-invariant-10: the I10 structural guard for @adonisjs-lasagna/crypto.
//
// I10 (packages/crypto/ARCHITECTURE.md): "A live DEK is singular per (subject ×
// category), and mutated only under the per-tenant lock." Two structural facts:
//
//   1. The wrapped-DEK migration must declare a PARTIAL unique index
//      `UNIQUE (subject_id, category) WHERE shredded_at IS NULL`, so the LIVE DEK is
//      singular while a shred tombstone can remain AND a later re-provision can
//      insert a fresh live row. A plain (non-partial) UNIQUE (subject_id, category)
//      is a violation: it would forbid the re-provision (§6.3, decision 6).
//   2. The provision AND shred paths in the service must run under the per-tenant
//      operation lock (`#locked(...)`), so two concurrent writers to one
//      (subject × category) DEK serialize (T12, §6.6).
//
// Pure auditors exported for focused unit tests; the runner reads the real files.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = 'packages/crypto/tenant_migrations'
const MIGRATION_MATCH = 'create_crypto_wrapped_deks_table'
const SERVICE_PATH = 'packages/crypto/src/services/crypto_service.ts'

// A partial unique on (subject_id, category) filtered to the live rows.
const PARTIAL_UNIQUE =
  /UNIQUE\s+INDEX[\s\S]{0,160}?\(\s*subject_id\s*,\s*category\s*\)\s*WHERE\s+shredded_at\s+IS\s+NULL/i
// Any (subject_id, category) uniqueness declaration, to find a plain one.
const ANY_SUBJECT_CATEGORY_UNIQUE =
  /UNIQUE[\s\S]{0,160}?\(\s*subject_id\s*,\s*category\s*\)([\s\S]{0,40})/gi

/**
 * Audit the wrapped-DEK migration for the partial-unique discipline. `files` is a
 * list of `{ path, source }`. Returns problem strings (empty = ok). Pure.
 */
export function auditPartialUnique(files) {
  const problems = []
  const migration = files.find((f) => f.path.includes(MIGRATION_MATCH))
  if (!migration) return problems

  if (!PARTIAL_UNIQUE.test(migration.source)) {
    problems.push(
      `${migration.path}: the wrapped-DEK table must declare a PARTIAL unique index UNIQUE (subject_id, category) WHERE shredded_at IS NULL (I10), so the LIVE DEK is singular and a re-provision after a shred is allowed.`
    )
  }

  // Any (subject_id, category) uniqueness that is NOT immediately scoped to the
  // live rows would forbid the legitimate re-provision (§6.3).
  for (const m of migration.source.matchAll(ANY_SUBJECT_CATEGORY_UNIQUE)) {
    const trailing = m[1] ?? ''
    if (!/WHERE\s+shredded_at\s+IS\s+NULL/i.test(trailing)) {
      problems.push(
        `${migration.path}: a non-partial UNIQUE (subject_id, category) forbids a legitimate re-provision after a shred (I10, §6.3); it must be filtered WHERE shredded_at IS NULL.`
      )
    }
  }

  return problems
}

/** Extract the body (including braces) of an `async <name>(...)` method by brace matching. */
function extractMethodBody(source, name) {
  const sigIdx = source.indexOf(`async ${name}(`)
  if (sigIdx === -1) return null
  const braceStart = source.indexOf('{', sigIdx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(braceStart, i + 1)
    }
  }
  return null
}

/**
 * Audit that the provision AND shred paths take the per-tenant operation lock (the
 * `#locked(...)` seam), so two concurrent writers to one (subject × category) DEK
 * serialize (I10, §6.6). Structural: each method body must call `#locked(`. Pure.
 */
export function auditOperationLock(files) {
  const problems = []
  const service = files.find((f) => f.path.endsWith('crypto_service.ts'))
  if (!service) return problems

  for (const method of ['shred', '#provisionUnderLock']) {
    const body = extractMethodBody(service.source, method)
    if (!body) {
      problems.push(
        `${service.path}: no async ${method}(...) method found (I10 lock discipline cannot be verified; provision + shred must serialize on the per-tenant lock).`
      )
      continue
    }
    if (!body.includes('#locked(')) {
      problems.push(
        `${service.path}: ${method}(...) must run under the per-tenant operation lock (this.#locked(...)) so provision/shred serialize on one (subject × category) DEK (I10, §6.6).`
      )
    }
  }

  return problems
}

function run() {
  const files = []
  const dirAbs = join(repoRoot, MIGRATIONS_DIR)
  if (existsSync(dirAbs)) {
    for (const name of readdirSync(dirAbs)) {
      if (name.includes(MIGRATION_MATCH) && name.endsWith('.ts')) {
        const rel = `${MIGRATIONS_DIR}/${name}`
        files.push({ path: rel, source: readFileSync(join(dirAbs, name), 'utf8') })
      }
    }
  }
  const serviceAbs = join(repoRoot, SERVICE_PATH)
  if (existsSync(serviceAbs)) {
    files.push({ path: SERVICE_PATH, source: readFileSync(serviceAbs, 'utf8') })
  }

  const problems = [...auditPartialUnique(files), ...auditOperationLock(files)]
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-10: ${problems.length} I10 (singular live DEK) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    'check-crypto-invariant-10: OK (partial UNIQUE on live DEKs; provision + shred take the per-tenant lock).'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
