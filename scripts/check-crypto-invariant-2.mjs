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
// The per-tenant wrapped-DEK migration (schema-pg / database-pg) is a runnable
// `.ts`; the SHARED rowscope table (rowscope-pg, where per-tenant migrations are a
// no-op) ships as a publishable `.stub`. The guard scans BOTH.
const PER_TENANT_DIR = 'packages/crypto/tenant_migrations'
const ROWSCOPE_DIR = 'packages/crypto/stubs/migrations'
const PER_TENANT_MATCH = 'create_crypto_wrapped_deks_table'
const ROWSCOPE_MATCH = 'create_crypto_wrapped_deks_rowscope'

/** A wrapped-DEK migration is the rowscope (shared-table) variant when its path says so. */
function isRowscope(path) {
  return path.includes('rowscope')
}

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

/**
 * The rowscope (shared-table) variant carries ONE extra reviewed column: `tenant_id`,
 * the scope discriminator (the store stamps + filters it; the partial UNIQUE and RLS
 * policy key on it). Still no plaintext-DEK column.
 */
export const ROWSCOPE_ALLOWED_COLUMNS = [...ALLOWED_COLUMNS, 'tenant_id']

/** The reviewed allowlist for one migration, by placement. */
function allowedFor(path) {
  return isRowscope(path) ? ROWSCOPE_ALLOWED_COLUMNS : ALLOWED_COLUMNS
}

// The type families a column line may declare. This MUST include the byte/blob and
// variable-length string families (`bytea`, `varchar`, `character varying`, `bit`,
// `varbinary`, `blob`): `bytea` is the natural Postgres type for raw key bytes, so a
// parser blind to it would let a plaintext-DEK column (`raw_key bytea`) slip past the
// allowlist — the exact I2 hole this guard closes. A new legitimate type is a reviewed
// addition here (an UNLISTED type makes its column invisible, so keep this generous).
const SQL_TYPE =
  /^\s*([a-z_]+)\s+(uuid|text|varchar|character\s+varying|bytea|varbinary|blob|bit|timestamptz|integer|bigint|boolean|jsonb|char|smallint|numeric|date)\b/

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
 * Audit every wrapped-DEK migration (per-tenant AND the shared rowscope variant).
 * `files` is a list of `{ path, source }`. Each file is checked against the
 * allowlist for its placement (rowscope adds `tenant_id`). Returns a list of problem
 * strings (empty = ok). Pure, so a unit test drives it without a filesystem.
 */
export function auditWrappedDekTable(files) {
  const problems = []
  const migrations = files.filter(
    (f) => f.path.includes(PER_TENANT_MATCH) || f.path.includes(ROWSCOPE_MATCH)
  )
  for (const migration of migrations) {
    const cols = sqlColumns(migration.source)
    const allowedList = allowedFor(migration.path)
    const allowed = new Set(allowedList)
    for (const col of cols) {
      if (!allowed.has(col)) {
        problems.push(
          `${migration.path}: column '${col}' is not in the reviewed non-plaintext allowlist (I2); a DEK is stored only wrapped in 'wrapped_dek'. Add it to the allowlist with review, or drop it.`
        )
      }
    }
    for (const want of allowedList) {
      if (!cols.includes(want)) {
        problems.push(
          `${migration.path}: allowlisted column '${want}' is missing from the wrapped-DEK table (I2).`
        )
      }
    }
  }
  return problems
}

/**
 * The wrapped-DEK migration markers that MUST each resolve to a real file. A rename,
 * a moved dir, or a typo in a marker would make the glob match zero files and the
 * guard pass SILENTLY — the repo's documented "dead guard" failure mode (inv-4 once
 * shipped false-green because its runner read zero files). The floor turns that into
 * a loud failure.
 */
export const REQUIRED_MIGRATION_MARKERS = [PER_TENANT_MATCH, ROWSCOPE_MATCH]

/** Markers with NO matching file among `files` (empty = all present). Pure. */
export function missingMigrationMarkers(files) {
  return REQUIRED_MIGRATION_MARKERS.filter((m) => !files.some((f) => f.path.includes(m)))
}

/** Read wrapped-DEK migration sources from a dir, filtered by name marker + extension. */
function readMigrations(dirRel, match, ext) {
  const files = []
  const dirAbs = join(repoRoot, dirRel)
  if (existsSync(dirAbs)) {
    for (const name of readdirSync(dirAbs)) {
      if (name.includes(match) && name.endsWith(ext)) {
        files.push({ path: `${dirRel}/${name}`, source: readFileSync(join(dirAbs, name), 'utf8') })
      }
    }
  }
  return files
}

/** Discover every wrapped-DEK migration on disk (per-tenant .ts + rowscope .stub). */
export function discoverMigrations() {
  return [
    ...readMigrations(PER_TENANT_DIR, PER_TENANT_MATCH, '.ts'),
    ...readMigrations(ROWSCOPE_DIR, ROWSCOPE_MATCH, '.stub'),
  ]
}

function run() {
  const files = discoverMigrations()

  const missing = missingMigrationMarkers(files)
  if (missing.length > 0) {
    console.error(
      `check-crypto-invariant-2: FATAL — no migration file found for marker(s): ${missing.join(', ')}. ` +
        `The wrapped-DEK table(s) must be present for I2 review; a rename/move would otherwise silently drop the guard.`
    )
    process.exit(1)
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
