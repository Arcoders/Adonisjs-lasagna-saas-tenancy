#!/usr/bin/env node
// check-crypto-invariant-5: the I5 structural guard for @adonisjs-lasagna/crypto.
//
// I5: "The search index is a keyed HMAC
// with a key in the KeyProvider, and its equality/frequency leak is a DOCUMENTED
// invariant." Equality search on a low-entropy identifier (a passport number) MUST
// use a keyed HMAC (createHmac), NEVER a bare UNKEYED digest which a DB dump
// brute-forces offline (T3). This scans three surfaces, all STRUCTURAL:
//   1. the blind-index module: it MUST import AND call a keyed HMAC (createHmac),
//      and MUST NOT reach for a bare unkeyed digest;
//   2. all crypto `src`: NO bare unkeyed digest anywhere OUTSIDE the reviewed
//      allowlist, because crypto's only KEYED-index hashing is the blind index; a
//      bare digest in a new place is the exact T3 footgun (or an unreviewed hashing
//      path the guard forces someone to justify by adding it to
//      CREATE_HASH_ALLOWLIST). The WORM shred ledger's non-PII subject digest is
//      the one reviewed carve-out;
//   3. the wrapped-DEK migration: no plaintext `salt` column (a salt-in-a-column
//      with a hash is the brute-forceable construction I5 rejects).
//
// "Unkeyed digest" is broader than the literal `createHash` token: the check scans
// import SPECIFIERS (so `import { createHash as h }` cannot alias past it) and the
// one-shot digest APIs (`crypto.hash`, Node 21+, and WebCrypto `subtle.digest`)
// that produce the same brute-forceable hash without ever naming createHash. Add a
// new unkeyed-hash entry point to UNKEYED_DIGEST_CALLS as it appears.
//
// Pure auditor exported for a focused unit test; the runner reads the real files.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const CRYPTO_SRC_DIR = 'packages/crypto/src'
const BLIND_INDEX_MATCH = 'internal/blind_index'
const MIGRATIONS_DIR = 'packages/crypto/tenant_migrations'
const MIGRATION_MATCH = 'create_crypto_wrapped_deks_table'

/**
 * The reviewed carve-out: files whose `createHash` is a non-index one-way digest,
 * NOT a blind index. Adding a file here is the reviewed decision the guard forces.
 * `worm_shred_ledger.ts` hashes the data-subject id to a non-PII digest before it
 * reaches the WORM ledger (never a searchable index over a low-entropy field), so
 * the T3 brute-force concern does not apply.
 */
export const CREATE_HASH_ALLOWLIST = ['services/worm_shred_ledger.ts']

function isAllowlistedForCreateHash(path) {
  const norm = path.replace(/\\/g, '/')
  return CREATE_HASH_ALLOWLIST.some((suffix) => norm.endsWith(suffix))
}

// The same per-line SQL column parser check-crypto-invariant-2 uses: the migration
// ships raw SQL, so columns are read `<name> <type>` per line.
const SQL_TYPE =
  /^\s*([a-z_]+)\s+(uuid|text|timestamptz|integer|bigint|boolean|jsonb|char|smallint|numeric|date|bytea)\b/

function sqlColumns(source) {
  const names = []
  for (const line of source.split('\n')) {
    const m = line.match(SQL_TYPE)
    if (m) names.push(m[1])
  }
  return names
}

// Comment lines are skipped so a doc-comment that says "NOT createHash" or names
// the forbidden call in prose is never a false positive.
function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** True if `<name>(` is CALLED on a non-comment line of `source`. */
function callsFn(source, name) {
  return source.split('\n').some((line) => !isComment(line) && line.includes(name + '('))
}

/**
 * True if `source` imports the named specifier from `node:crypto`, INCLUDING the
 * aliased form (`import { createHash as h } from 'node:crypto'`). Scanning the
 * specifier, not just the call token, is what stops an alias from smuggling a bare
 * digest past the guard. Handles single- and multi-line import blocks.
 */
function importsFromNodeCrypto(source, name) {
  const re = /import\s*\{([\s\S]*?)\}\s*from\s*['"]node:crypto['"]/g
  let m
  while ((m = re.exec(source)) !== null) {
    const specs = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    if (specs.includes(name)) return true
  }
  return false
}

// One-shot UNKEYED digest APIs that produce the same brute-forceable hash as
// createHash without ever naming it: `crypto.hash` (Node 21+) and WebCrypto
// `subtle.digest`. Matched as qualified call tokens so a keyed `createHmac(...)
// .digest('hex')` chain is NOT flagged (it is `.digest(`, not `subtle.digest(`).
const UNKEYED_DIGEST_CALLS = ['crypto.hash', 'subtle.digest']

/**
 * True if `source` reaches for a bare UNKEYED digest: a createHash import (aliased
 * or not), a `crypto.createHash(` namespace call, or a one-shot digest API. This is
 * the T3 footgun a blind index must never use.
 */
function usesUnkeyedDigest(source) {
  return (
    importsFromNodeCrypto(source, 'createHash') ||
    callsFn(source, 'createHash') ||
    UNKEYED_DIGEST_CALLS.some((name) => callsFn(source, name))
  )
}

/** True if `source` genuinely IMPORTS and CALLS the keyed HMAC (not a decoy token). */
function usesKeyedHmac(source) {
  return importsFromNodeCrypto(source, 'createHmac') && callsFn(source, 'createHmac')
}

function isSrcFile(path) {
  return /(^|[\\/])src[\\/].+\.(m|c)?ts$/.test(path)
}

/**
 * Audit the blind-index surfaces. `files` is a list of `{ path, source }`. Returns
 * a list of problem strings (empty = ok). Pure, so a unit test drives it without a
 * filesystem.
 */
export function auditBlindIndex(files) {
  const problems = []
  const blindIndex = files.find((f) => f.path.replace(/\\/g, '/').includes(BLIND_INDEX_MATCH))

  if (blindIndex) {
    if (!usesKeyedHmac(blindIndex.source)) {
      problems.push(
        `${blindIndex.path}: the blind index must import AND call a keyed HMAC (createHmac from node:crypto), which was not found (I5, T3).`
      )
    }
    if (usesUnkeyedDigest(blindIndex.source)) {
      problems.push(
        `${blindIndex.path}: the blind index reaches for a bare unkeyed digest (createHash / crypto.hash / subtle.digest); a low-entropy identifier is brute-forceable from a DB dump. Use a keyed createHmac (I5, T3).`
      )
    }
  }

  // No bare unkeyed digest ANYWHERE else in crypto src: crypto's only hashing is the
  // keyed blind index. A bare digest in any other src file is the T3 footgun or an
  // unreviewed hashing path; the guard forces the reviewed decision.
  for (const f of files) {
    if (f === blindIndex) continue
    if (!isSrcFile(f.path)) continue
    if (isAllowlistedForCreateHash(f.path)) continue
    if (usesUnkeyedDigest(f.source)) {
      problems.push(
        `${f.path}: crypto src must never use a bare unkeyed digest (createHash / crypto.hash / subtle.digest); a blind index must be a keyed createHmac (I5, T3). If this is a reviewed non-index one-way hash, add it to CREATE_HASH_ALLOWLIST.`
      )
    }
  }

  const migration = files.find((f) => f.path.includes(MIGRATION_MATCH))
  if (migration) {
    for (const col of sqlColumns(migration.source)) {
      if (/salt/.test(col)) {
        problems.push(
          `${migration.path}: column '${col}' looks like a plaintext salt; the blind index is a KeyProvider-keyed HMAC, not a salted hash, so no salt column belongs on the table (I5).`
        )
      }
    }
  }

  return problems
}

function collectSrcFiles(dirRel) {
  const files = []
  const dirAbs = join(repoRoot, dirRel)
  if (!existsSync(dirAbs)) return files
  for (const name of readdirSync(dirAbs, { recursive: true })) {
    const rel = `${dirRel}/${String(name).replace(/\\/g, '/')}`
    if (!/\.(m|c)?ts$/.test(rel)) continue
    const abs = join(repoRoot, rel)
    files.push({ path: rel, source: readFileSync(abs, 'utf8') })
  }
  return files
}

function run() {
  const files = collectSrcFiles(CRYPTO_SRC_DIR)

  const migDirAbs = join(repoRoot, MIGRATIONS_DIR)
  if (existsSync(migDirAbs)) {
    for (const name of readdirSync(migDirAbs)) {
      if (name.includes(MIGRATION_MATCH) && name.endsWith('.ts')) {
        const rel = `${MIGRATIONS_DIR}/${name}`
        files.push({ path: rel, source: readFileSync(join(migDirAbs, name), 'utf8') })
      }
    }
  }

  const problems = auditBlindIndex(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-5: ${problems.length} I5 (blind-index keyed-HMAC) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-crypto-invariant-5: OK (${files.length} crypto file(s), blind index is a keyed HMAC, no bare hash).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
