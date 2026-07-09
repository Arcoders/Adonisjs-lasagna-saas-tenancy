#!/usr/bin/env node
// check-crypto-invariant-1: the I1 structural guard for @adonisjs-lasagna/crypto.
//
// I1 (packages/crypto/ARCHITECTURE.md §4): "A field marked encrypted is stored as
// enc_v2 ciphertext under a per-(subject x category) DEK, never plaintext. There is
// no plaintext PII column for an encrypted field." This is the STRUCTURAL scaffold
// for the encrypted-model surface (the runtime backstop is invariant-3's DB CHECK):
//
//   1. the decorators OWN the column — `encrypted()` and `searchable()` each apply
//      `lucidColumn(...)` internally, so the encrypted field IS the (single) column
//      and no separate un-columned plaintext attribute is created; `searchable()`
//      hides its HMAC from serialization by default (`serializeAs: null`);
//   2. every `@encrypted` / `@searchable` property is typed as a CIPHERTEXT STRING
//      (`string`, optionally `| null` / `| undefined`) — the value on disk is an
//      enc_v2 string, so a non-string type (`number`, `Date`, `boolean`, `Buffer`,
//      an array, ...) means a plaintext-typed column and is refused.
//
// It cannot statically prove a host did not ALSO add an unrelated plaintext column
// holding the same secret in its own schema (that is the host's data model, and the
// DB-level `check-crypto-invariant-3` prefix constraint is the real at-rest
// enforcement); it pins the surface crypto owns. Comments AND string/template literals
// are blanked so a decorator token that appears in prose, JSDoc, or a string constant
// (help text, an error message, a generated snippet) is never mistaken for a real
// `@`-decorator, and a paren inside a string never desyncs the matcher. Pure auditor
// exported for a focused unit test; the runner reads the real files.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const CRYPTO_SRC_DIR = 'packages/crypto/src'
const CRYPTO_FIXTURES_DIR = 'packages/crypto/tests/fixtures'
const DECORATOR_DEF_MATCH = 'models/encrypted_columns.ts'

/**
 * Blank comments AND string/template literals so a decorator token that only appears
 * in prose, JSDoc, or a string constant is never scanned as a real `@`-decorator, and
 * a paren inside a string literal never desyncs the paren matcher. Comments are blanked
 * FIRST, so a quote inside a comment cannot leave a dangling delimiter for the string
 * pass. Literal contents collapse to empty (balanced) quotes so paren depth is
 * preserved for the surrounding code.
 */
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
}

/** Extract the `{...}` body of an `export function <name>(` by brace matching. */
function extractFnBody(source, name) {
  const sigIdx = source.indexOf(`function ${name}(`)
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

/** Index of the `)` that closes the `(` at `openIdx` (paren-depth matched). */
function matchParen(source, openIdx) {
  let depth = 0
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) return i
  }
  return -1
}

/**
 * A `string` / `string | null` / `string | undefined` union (a ciphertext string
 * column). Every alternative must be exactly `string`, `null`, or `undefined`; a
 * `number` / `Date` / `Buffer` / `string[]` / object part fails.
 */
function isCiphertextStringType(type) {
  const parts = type
    .trim()
    .split('|')
    .map((p) => p.trim())
  if (parts.length === 0 || parts.some((p) => p === '')) return false
  const hasString = parts.includes('string')
  return hasString && parts.every((p) => p === 'string' || p === 'null' || p === 'undefined')
}

/**
 * Find every `@encrypted(...)` / `@searchable(...)` decorator applied in `@`-syntax
 * and the property it decorates, returning `{ kind, name, type }`. The decorator
 * args can span lines and contain nested parens (arrow subject/from resolvers), so
 * the closing paren is matched by depth, not a regex.
 */
function findDecoratedProps(source) {
  const found = []
  const clean = stripNonCode(source)
  const re = /@(encrypted|searchable)\s*\(/g
  let m
  while ((m = re.exec(clean)) !== null) {
    const kind = m[1]
    const openIdx = clean.indexOf('(', m.index)
    const closeIdx = matchParen(clean, openIdx)
    if (closeIdx === -1) continue
    // The property declaration follows the decorator: `[declare|public|readonly ]
    // <name>[!?]: <type>` up to `=`, `;`, `{`, or newline.
    const after = clean.slice(closeIdx + 1)
    const prop = after.match(
      /^\s*(?:(?:declare|public|private|protected|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*[!?]?\s*:\s*([^\n=;{]+)/
    )
    if (!prop) {
      found.push({ kind, name: '(unparsed)', type: null })
      continue
    }
    found.push({ kind, name: prop[1], type: prop[2].trim() })
    re.lastIndex = closeIdx + 1
  }
  return found
}

/**
 * Audit the encrypted-model surface. `files` is a list of `{ path, source }`.
 * Returns problem strings (empty = ok). Pure, so a unit test drives it.
 */
export function auditEncryptedModelSurface(files) {
  const problems = []

  // 1. The decorators own the column (they apply `lucidColumn` themselves).
  const def = files.find((f) => f.path.replace(/\\/g, '/').includes(DECORATOR_DEF_MATCH))
  if (def) {
    const clean = stripNonCode(def.source)
    const encBody = extractFnBody(clean, 'encrypted')
    const searchBody = extractFnBody(clean, 'searchable')
    if (encBody && !/lucidColumn\s*\(/.test(encBody)) {
      problems.push(
        `${def.path}: encrypted() must apply lucidColumn(...) so the encrypted field IS the column (I1); no separate plaintext attribute.`
      )
    }
    if (searchBody && !/lucidColumn\s*\(/.test(searchBody)) {
      problems.push(
        `${def.path}: searchable() must apply lucidColumn(...) so the blind index IS a column (I1).`
      )
    }
    if (searchBody && !/serializeAs\s*:\s*null/.test(searchBody)) {
      problems.push(
        `${def.path}: searchable() must default serializeAs: null so the blind-index HMAC (an equality/frequency leak, I5) is not serialized into an API response by default (I1).`
      )
    }
  }

  // 2. Every decorated property is a ciphertext string column.
  for (const file of files) {
    for (const prop of findDecoratedProps(file.source)) {
      if (prop.type === null) {
        problems.push(
          `${file.path}: an @${prop.kind}(...) decorator has no parseable property type; an encrypted/searchable column must be a ciphertext string (I1).`
        )
        continue
      }
      if (!isCiphertextStringType(prop.type)) {
        problems.push(
          `${file.path}: @${prop.kind} '${prop.name}' is typed '${prop.type}', not a ciphertext string (string | null | undefined). The value on disk is an enc_v2 string; a non-string type is a plaintext-typed column (I1).`
        )
      }
    }
  }

  return problems
}

function collectFiles(dirRel) {
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
  const files = [...collectFiles(CRYPTO_SRC_DIR), ...collectFiles(CRYPTO_FIXTURES_DIR)]
  const problems = auditEncryptedModelSurface(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-1: ${problems.length} I1 (encrypted-model surface) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-crypto-invariant-1: OK (${files.length} crypto model file(s), encrypted columns are ciphertext strings, no plaintext sibling).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
