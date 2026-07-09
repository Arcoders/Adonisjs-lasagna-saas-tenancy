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
// The per-tenant wrapped-DEK migration is a runnable `.ts`; the SHARED rowscope
// table (rowscope-pg, where per-tenant migrations are a no-op) ships as a `.stub`.
const PER_TENANT_DIR = 'packages/crypto/tenant_migrations'
const ROWSCOPE_DIR = 'packages/crypto/stubs/migrations'
const PER_TENANT_MATCH = 'create_crypto_wrapped_deks_table'
const ROWSCOPE_MATCH = 'create_crypto_wrapped_deks_rowscope'
const SERVICE_PATH = 'packages/crypto/src/services/crypto_service.ts'

/** A wrapped-DEK migration is the rowscope (shared-table) variant when its path says so. */
function isRowscope(path) {
  return path.includes('rowscope')
}

// A partial unique on the live rows. Per-tenant keys on (subject_id, category); the
// shared rowscope table keys on (tenant_id, subject_id, category) so the LIVE DEK is
// singular WITHIN a tenant (a global (subject, category) unique would let one tenant
// block another from provisioning).
const PARTIAL_UNIQUE_PER_TENANT =
  /UNIQUE\s+INDEX[\s\S]{0,160}?\(\s*subject_id\s*,\s*category\s*\)\s*WHERE\s+shredded_at\s+IS\s+NULL/i
const PARTIAL_UNIQUE_ROWSCOPE =
  /UNIQUE\s+INDEX[\s\S]{0,200}?\(\s*tenant_id\s*,\s*subject_id\s*,\s*category\s*\)\s*WHERE\s+shredded_at\s+IS\s+NULL/i
// Within ONE statement, a UNIQUE on (subject_id, category) or (tenant_id, subject_id,
// category); the capture is the rest of that statement, checked for the live filter.
// The per-statement split (below) stops one declaration's tail from bridging into the
// next, so a valid partial index immediately followed by a rogue plain one is still
// caught.
const SUBJECT_CATEGORY_UNIQUE =
  /UNIQUE[\s\S]*?\(\s*(?:tenant_id\s*,\s*)?subject_id\s*,\s*category\s*\)([\s\S]*)/i

/**
 * Blank JS block + line comments so the cross-line UNIQUE scan never trips on prose
 * (a JSDoc that MENTIONS `UNIQUE (subject_id, category)` is not a declaration). The
 * DDL lives in template strings, so it survives. Replacing with a space (not empty)
 * keeps offsets from fusing tokens across a stripped span.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Audit each wrapped-DEK migration (per-tenant AND the shared rowscope variant) for
 * the partial-unique discipline. `files` is a list of `{ path, source }`. Returns
 * problem strings (empty = ok). Pure.
 */
export function auditPartialUnique(files) {
  const problems = []
  const migrations = files.filter(
    (f) => f.path.includes(PER_TENANT_MATCH) || f.path.includes(ROWSCOPE_MATCH)
  )
  for (const migration of migrations) {
    const rowscope = isRowscope(migration.path)
    const source = stripComments(migration.source)
    const wantPartial = rowscope ? PARTIAL_UNIQUE_ROWSCOPE : PARTIAL_UNIQUE_PER_TENANT
    if (!wantPartial.test(source)) {
      const cols = rowscope ? '(tenant_id, subject_id, category)' : '(subject_id, category)'
      problems.push(
        `${migration.path}: the wrapped-DEK table must declare a PARTIAL unique index UNIQUE ${cols} WHERE shredded_at IS NULL (I10), so the LIVE DEK is singular and a re-provision after a shred is allowed.`
      )
    }

    // Any (subject_id, category) / (tenant_id, subject_id, category) uniqueness that
    // is NOT immediately scoped to the live rows would forbid the re-provision (§6.3).
    // Scan PER STATEMENT (split on the CREATE keyword) so one declaration's trailing
    // window cannot swallow a following rogue non-partial declaration.
    for (const statement of source.split(/(?=\bCREATE\b)/i)) {
      const m = statement.match(SUBJECT_CATEGORY_UNIQUE)
      if (!m) continue
      if (!/WHERE\s+shredded_at\s+IS\s+NULL/i.test(m[1] ?? '')) {
        problems.push(
          `${migration.path}: a non-partial UNIQUE on (subject_id, category) forbids a legitimate re-provision after a shred (I10, §6.3); it must be filtered WHERE shredded_at IS NULL.`
        )
      }
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

/**
 * The wrapped-DEK migration markers that MUST each resolve to a real file. A rename,
 * a moved dir, or a typo in a marker would make the glob match zero files and the
 * guard pass SILENTLY — the repo's documented "dead guard" failure mode. The floor in
 * run() turns that into a loud failure.
 */
export const REQUIRED_MIGRATION_MARKERS = [PER_TENANT_MATCH, ROWSCOPE_MATCH]

/** Markers with NO matching file among `files` (empty = all present). Pure. */
export function missingMigrationMarkers(files) {
  return REQUIRED_MIGRATION_MARKERS.filter((m) => !files.some((f) => f.path.includes(m)))
}

/** Read wrapped-DEK migration sources from a dir, filtered by name marker + extension. */
function readMigrations(dirRel, match, ext) {
  const out = []
  const dirAbs = join(repoRoot, dirRel)
  if (existsSync(dirAbs)) {
    for (const name of readdirSync(dirAbs)) {
      if (name.includes(match) && name.endsWith(ext)) {
        out.push({ path: `${dirRel}/${name}`, source: readFileSync(join(dirAbs, name), 'utf8') })
      }
    }
  }
  return out
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
      `check-crypto-invariant-10: FATAL — no migration file found for marker(s): ${missing.join(', ')}. ` +
        `The wrapped-DEK table(s) must be present for I10 review; a rename/move would otherwise silently drop the guard.`
    )
    process.exit(1)
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
