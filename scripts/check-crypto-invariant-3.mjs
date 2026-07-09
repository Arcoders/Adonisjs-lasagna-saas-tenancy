#!/usr/bin/env node
// check-crypto-invariant-3: the I3 structural guard for @adonisjs-lasagna/crypto.
//
// I3 (packages/crypto/ARCHITECTURE.md §4): "Reads fail closed; writes reject cleartext
// for an encrypted field." Two structural properties, one per direction:
//
//   READ  — EVERY field read routes through the strict open seam (openV2WithKey, whose
//           miss/tamper throws) and NO frame on the read path swallows that throw. The
//           read path is wider than one method: the @encrypted decorator decrypts via
//           decryptModelFields -> EncryptedRepository.decrypt -> CryptoService.decryptField,
//           and the mixin hooks (boot's decryptHook/decryptEach) wrap it. A lenient
//           `catch` in ANY of those frames would surface ciphertext-as-plaintext (T6)
//           while the strict opener itself stays pristine, so the guard scans the WHOLE
//           read path, not just decryptField:
//             - crypto_service.ts        decryptField        (calls openV2WithKey, no catch)
//             - encrypted_repository.ts  decrypt             (delegates to decryptField, no catch)
//             - encrypted_columns.ts     decryptModelFields  (loops repo.decrypt, no catch)
//             - with_encrypted_fields.ts boot                (the decrypt hooks, no catch)
//           This matches the design's "NO lenient-decrypt carve-out ANYWHERE in crypto
//           src" (01-crypto.md §4/§5), which one method could not enforce.
//
//   WRITE — the DB-level fail-closed backstop for T5 exists: the migration helper
//           (src/schema/encrypted_column.ts) emits a CHECK constraint that refuses a
//           non-enc_v2:/enc_v1: value at rest. This is the only enforcement that catches
//           the raw-SQL and query-builder bypasses the model hooks cannot; a host applies
//           it to each encrypted column. The guard pins the mechanism ships and accepts
//           BOTH ciphertext prefixes.
//
// Comment lines are stripped so prose naming a token is never a false positive. Pure
// auditor exported for a focused unit test; the runner reads the real files.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const CRYPTO_SRC_DIR = 'packages/crypto/src'
const SERVICE_MATCH = 'services/crypto_service.ts'
const CHECK_HELPER_MATCH = 'schema/encrypted_column.ts'
const STRICT_OPEN = 'openV2WithKey'

// The full field-read path: the frames a decrypted value flows through before it
// reaches the app. Each must be lenient-carve-out-free (no `catch` that could swallow
// the strict throw). `mustCall`, when set, pins the delegation to the strict choke
// point so a frame cannot quietly stop routing through it.
const READ_PATH = [
  { match: SERVICE_MATCH, fn: 'decryptField', mustCall: STRICT_OPEN, required: true },
  { match: 'services/encrypted_repository.ts', fn: 'decrypt', mustCall: 'decryptField' },
  { match: 'models/encrypted_columns.ts', fn: 'decryptModelFields', mustCall: 'decrypt' },
  { match: 'models/with_encrypted_fields.ts', fn: 'boot', mustCall: null },
]

/** Replace comments with spaces so a token in prose / JSDoc is never scanned. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Extract the `{...}` body of a definition named `name`, whether it is an
 * `async name(` / `name(` method, an `async function name(` / `function name(`
 * declaration, or a `static name(` method, by brace matching from its first `{`.
 * Anchors on a DEFINITION form (not a bare call) so a call site does not mis-anchor.
 */
function extractBody(source, name) {
  const forms = [
    `async function ${name}(`,
    `function ${name}(`,
    `async ${name}(`,
    `static ${name}(`,
    `${name}(`,
  ]
  let sigIdx = -1
  for (const form of forms) {
    sigIdx = source.indexOf(form)
    if (sigIdx !== -1) break
  }
  if (sigIdx === -1) return null
  const braceStart = source.indexOf('{', sigIdx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(braceStart, i + 1)
  }
  return null
}

/** True if `<name>(` is CALLED on `source`, matched at a word boundary. */
function callsFn(source, name) {
  return new RegExp(`(?:^|[^\\w$])${name}\\(`).test(source)
}

/**
 * Audit the I3 fail-closed read path + write-backstop. `files` is a list of
 * `{ path, source }`. Returns problem strings (empty = ok). Pure.
 */
export function auditFailClosed(files) {
  const problems = []
  const find = (m) => files.find((f) => f.path.replace(/\\/g, '/').includes(m))

  // READ: every frame on the field-read path is lenient-carve-out-free.
  for (const target of READ_PATH) {
    const file = find(target.match)
    if (!file) {
      if (target.required) {
        problems.push(
          `${target.match} was not found; I3 requires a strict field-decrypt path (${STRICT_OPEN}).`
        )
      }
      continue
    }
    const body = extractBody(stripComments(file.source), target.fn)
    if (!body) {
      problems.push(
        `${file.path}: read-path method ${target.fn}(...) was not found (I3); a rename must keep the fail-closed read guarded.`
      )
      continue
    }
    if (target.mustCall === STRICT_OPEN && !callsFn(body, STRICT_OPEN)) {
      problems.push(
        `${file.path}: ${target.fn} must open the value through the STRICT ${STRICT_OPEN}(...) seam (I3, T6); a read whose value is not enc_v1/enc_v2 ciphertext must throw, never return as plaintext.`
      )
    } else if (
      target.mustCall &&
      target.mustCall !== STRICT_OPEN &&
      !callsFn(body, target.mustCall)
    ) {
      problems.push(
        `${file.path}: ${target.fn} must delegate to ${target.mustCall}(...) so every read funnels through the single strict choke point (I3).`
      )
    }
    if (/\bcatch\b/.test(body)) {
      problems.push(
        `${file.path}: ${target.fn} contains a catch; the strict ${STRICT_OPEN} throw must propagate on every read-path frame (fail-closed, I3/T6). A caught-and-returned value would be a lenient-decrypt carve-out.`
      )
    }
  }

  // WRITE: the DB-level CHECK backstop that closes T5 for encrypted field columns.
  const helper = find(CHECK_HELPER_MATCH)
  if (!helper) {
    problems.push(
      `${CHECK_HELPER_MATCH} was not found; I3/T5 requires the DB-level ciphertext CHECK helper (only a database constraint catches the raw-SQL / query-builder write bypass).`
    )
  } else {
    const clean = stripComments(helper.source)
    const requires = [
      { token: 'ADD CONSTRAINT', why: 'emit an ALTER TABLE ... ADD CONSTRAINT statement' },
      { token: 'CHECK', why: 'emit a CHECK constraint' },
      { token: 'enc_v2:', why: 'accept the current enc_v2 ciphertext prefix' },
      { token: 'enc_v1:', why: 'accept the legacy enc_v1 prefix (APP_KEY migration window)' },
    ]
    for (const { token, why } of requires) {
      if (!clean.includes(token)) {
        problems.push(
          `${helper.path}: the ciphertext CHECK helper must ${why} (missing '${token}'), so the DB-level T5 backstop is complete (I3).`
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
    files.push({ path: rel, source: readFileSync(join(repoRoot, rel), 'utf8') })
  }
  return files
}

function run() {
  const files = collectSrcFiles(CRYPTO_SRC_DIR)
  const problems = auditFailClosed(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-3: ${problems.length} I3 (fail-closed read/write) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    'check-crypto-invariant-3: OK (strict openV2WithKey read path with no lenient catch on any frame; DB-level ciphertext CHECK backstop present).'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
