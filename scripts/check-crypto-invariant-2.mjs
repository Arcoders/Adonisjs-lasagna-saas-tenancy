#!/usr/bin/env node
// check-crypto-invariant-2: the I2 structural guard for @adonisjs-lasagna/crypto.
//
// I2 (packages/crypto/ARCHITECTURE.md): "DEKs are stored ONLY wrapped under the
// KEK; the KEK never lives in the database." The per-tenant wrapped-DEK table must
// carry EXACTLY the reviewed non-plaintext column allowlist and NO plaintext-DEK
// column (`dek`, `plaintext_key`, `raw_key`, ...). A new column is a reviewed edit
// to ALLOWED_COLUMNS here.
//
// The migration ships raw SQL (a `CREATE TABLE` inside `this.schema.raw(...)`), so
// columns are read per line (`<name> <type> ...`), which is robust to the nested
// parens of the CHECK constraint. Pure auditor exported for a focused unit test;
// the runner reads the real migration.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = 'packages/crypto/tenant_migrations'
const MIGRATION_MATCH = 'create_crypto_wrapped_deks_table'

/**
 * The fixed non-plaintext column allowlist for the wrapped-DEK table (crypto
 * §6.3). Adding a column here is the reviewed decision the guard forces. There is
 * deliberately NO `dek` / `plaintext_key` / `raw_key` column: the DEK is stored
 * only wrapped, in `wrapped_dek`.
 */
export const ALLOWED_COLUMNS = [
  'id',
  'subject_id',
  'category',
  'wrapped_dek',
  'kek_id',
  'created_at',
  'shredded_at',
]

const SQL_TYPE =
  /^\s*([a-z_]+)\s+(uuid|text|timestamptz|integer|bigint|boolean|jsonb|char|smallint|numeric|date)\b/

/** Column names declared by the raw `CREATE TABLE` body, one per line. */
function sqlColumns(source) {
  const names = []
  for (const line of source.split('\n')) {
    const m = line.match(SQL_TYPE)
    if (m) names.push(m[1])
  }
  return names
}

/**
 * Audit the wrapped-DEK migration. `files` is a list of `{ path, source }`.
 * Returns a list of problem strings (empty = ok). Pure, so a unit test drives it
 * without a filesystem.
 */
export function auditWrappedDekTable(files) {
  const problems = []
  const migration = files.find((f) => f.path.includes(MIGRATION_MATCH))
  if (!migration) return problems

  const cols = sqlColumns(migration.source)
  const allowed = new Set(ALLOWED_COLUMNS)
  for (const col of cols) {
    if (!allowed.has(col)) {
      problems.push(
        `${migration.path}: column '${col}' is not in the reviewed non-plaintext allowlist (I2); a DEK is stored only wrapped in 'wrapped_dek'. Add it to ALLOWED_COLUMNS with review, or drop it.`
      )
    }
  }
  for (const want of ALLOWED_COLUMNS) {
    if (!cols.includes(want)) {
      problems.push(
        `${migration.path}: allowlisted column '${want}' is missing from the wrapped-DEK table (I2).`
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

  const problems = auditWrappedDekTable(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-2: ${problems.length} I2 (wrapped-DEK column) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-crypto-invariant-2: OK (${files.length} wrapped-DEK migration(s), non-plaintext allowlist).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
