#!/usr/bin/env node
// check-crypto-invariant-10: the I10 structural guard for @adonisjs-lasagna/crypto.
//
// I10 (packages/crypto/ARCHITECTURE.md): "A live DEK is singular per (subject ×
// category)." The wrapped-DEK migration must declare a PARTIAL unique index
// `UNIQUE (subject_id, category) WHERE shredded_at IS NULL`, so the LIVE DEK is
// singular while a shred tombstone can remain AND a later re-provision can insert a
// fresh live row. A plain (non-partial) UNIQUE (subject_id, category) is a
// violation: it would forbid the re-provision (§6.3, decision 6).
//
// (The lock half of I10 — provision/shred serialize on the per-tenant operation
// lock — lands with the lock wiring in a later phase and is added to this guard
// then.) Pure auditor exported for a focused unit test; the runner reads the real
// migration.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = 'packages/crypto/tenant_migrations'
const MIGRATION_MATCH = 'create_crypto_wrapped_deks_table'

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

  const problems = auditPartialUnique(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-10: ${problems.length} I10 (singular live DEK) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-crypto-invariant-10: OK (${files.length} wrapped-DEK migration(s), partial UNIQUE).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
