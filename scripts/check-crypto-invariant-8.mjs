#!/usr/bin/env node
// check-crypto-invariant-8: the I8 structural guard for @adonisjs-lasagna/crypto.
//
// I8: "KEK rotation re-WRAPS DEKs; it never
// re-encrypts the data." The KEK-rotation walker (`tenant:crypto:rekek`) must
// unwrap each DEK under the old KEK and re-wrap it under the new one via the
// KeyProvider. It must NEVER decrypt a field VALUE and re-encrypt it (which would
// be O(number of field values), corrupt the AAD binding, and defeat the O(1)
// re-wrap). This scans the walker module, STRUCTURALLY:
//   1. it MUST call `unwrapDek(` AND `wrapDek(` (it re-wraps the DEK envelope);
//   2. it MUST NOT name `openV2WithKey` / `sealV2WithKey` (the field-value
//      open/seal seam) and MUST NOT import core's `.../crypto` primitive, because the
//      re-wrap path touches DEK envelopes only, never a field value.
//
// Comment lines are skipped so the walker's own doc-comment ("never
// openV2WithKey-then-sealV2WithKey") is not a false positive. Pure auditor exported
// for a focused unit test; the runner reads the real files.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const CRYPTO_SRC_DIR = 'packages/crypto/src'
// The KEK-rotation walker: the file that re-wraps DEKs under the current KEK.
const WALKER_MATCH = 'services/rekek_service'

// The core field-value seal/open seam. Naming or importing it on the re-wrap path
// is the exact "decrypt-then-re-encrypt the data" anti-pattern I8 forbids.
const FORBIDDEN_FIELD_SEAL = ['openV2WithKey', 'sealV2WithKey']
const CORE_CRYPTO_IMPORT = '@adonisjs-lasagna/saas-tenancy/crypto'

/** Comment lines are skipped so prose naming a forbidden token is never flagged. */
function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** True if `token` appears on any non-comment line of `source`. */
function mentions(source, token) {
  return source.split('\n').some((line) => !isComment(line) && line.includes(token))
}

/**
 * True if `<name>(` is CALLED on a non-comment line of `source`, matched at a word
 * boundary so `wrapDek(` is NOT satisfied by the `unwrapDek(` substring.
 */
function callsFn(source, name) {
  const re = new RegExp(`(?:^|[^\\w$])${name}\\(`)
  return source.split('\n').some((line) => !isComment(line) && re.test(line))
}

/**
 * Audit the KEK-rotation walker. `files` is a list of `{ path, source }`. Returns a
 * list of problem strings (empty = ok). Pure, so a unit test drives it without a
 * filesystem.
 */
export function auditRekekWalker(files) {
  const problems = []
  const walkers = files.filter((f) => f.path.replace(/\\/g, '/').includes(WALKER_MATCH))

  if (walkers.length === 0) {
    problems.push(
      `the KEK-rotation walker (${WALKER_MATCH}.ts) was not found; I8 requires a re-wrap walker that calls KeyProvider.unwrapDek/wrapDek.`
    )
    return problems
  }

  for (const walker of walkers) {
    if (!callsFn(walker.source, 'unwrapDek') || !callsFn(walker.source, 'wrapDek')) {
      problems.push(
        `${walker.path}: the KEK-rotation walker must re-WRAP the DEK — call BOTH KeyProvider.unwrapDek(...) and wrapDek(...) (I8, §6.7).`
      )
    }
    for (const token of FORBIDDEN_FIELD_SEAL) {
      if (mentions(walker.source, token)) {
        problems.push(
          `${walker.path}: the KEK-rotation walker names '${token}' — I8 re-WRAPS the DEK envelope and must NEVER decrypt/re-encrypt a field VALUE (openV2WithKey/sealV2WithKey). Re-wrap via KeyProvider.unwrapDek/wrapDek only.`
        )
      }
    }
    if (mentions(walker.source, CORE_CRYPTO_IMPORT)) {
      problems.push(
        `${walker.path}: the KEK-rotation walker imports core's '${CORE_CRYPTO_IMPORT}' field-value seam; I8 touches DEK envelopes only, so the walker must not reach for the field-value cipher.`
      )
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
    files.push({ path: rel, source: readFileSync(join(repoRoot, rel), 'utf8') })
  }
  return files
}

function run() {
  const files = collectSrcFiles(CRYPTO_SRC_DIR)
  const problems = auditRekekWalker(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-8: ${problems.length} I8 (KEK re-wrap) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log('check-crypto-invariant-8: OK (KEK-rotation walker re-wraps DEKs, no field-value seal).')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
