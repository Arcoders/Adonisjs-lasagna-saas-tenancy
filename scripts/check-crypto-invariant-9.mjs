#!/usr/bin/env node
// check-crypto-invariant-9: the I9 structural guard for @adonisjs-lasagna/crypto.
//
// I9: "Raw DEK/KEK/index-key bytes never enter a
// log, an error, a config literal, or a prompt." The whole key hierarchy is worthless
// if a key leaks through a log line, an error body, or a hardcoded literal (T11). This
// scans crypto src three ways:
//
//   - a raw-key identifier flowing into a LOG or ERROR sink: `console.*`, `logger.*`
//     (incl. `this.logger` / `#logger`), `process.stdout|stderr.write(`, a bare `warn(`,
//     or any `new <X>Exception(` / `new <X>Error(` construction;
//   - a raw key inside a bare thrown template string (`throw \`...${dek}...\``);
//   - a secret-key-named binding assigned a HARDCODED literal (the config-literal /
//     never-hardcoded clause): `const dek = Buffer.from('..')`, `const appKey = '..'`,
//     `const kek = process.env.KEK ?? 'fallback'`.
//
//   raw-key identifiers are `dek`, `kek`, `indexKey`, `appKey`, `oldAppKey`: the actual
//   key-BYTES variables. A `.length` / `.byteLength` is fine (a size, not the key), so
//   those are excluded; method/constant names like `wrapDek` / `deriveKek` / `kekId` /
//   `KEK_SALT` do not match (a capital D/K or an extra segment, not the raw buffer).
//
// String literals are blanked and template literals keep only their `${...}`
// expressions (mirroring check-ai-no-prompt-logging-for-training), so a message that
// merely NAMES a key ('APP_KEY is not set') never trips it, but a logged `${dek}` does.
// Pure auditor exported for a focused unit test; the runner reads the real files.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const CRYPTO_SRC_DIR = 'packages/crypto/src'

const SINK =
  /(?:\bconsole|\blogger)\s*\.\s*\w+\s*\(|\bprocess\s*\.\s*(?:stdout|stderr)\s*\.\s*write\s*\(|\bwarn\s*\(|new\s+\w*(?:Exception|Error)\s*\(/g
// A raw-key-bytes identifier NOT immediately narrowed to a size (`.length`/`.byteLength`).
const KEY = /\b(?:dek|kek|indexKey|appKey|oldAppKey)\b(?!\s*\.\s*(?:length|byteLength))/

// A secret-key-named binding (EXACTLY a key var, case-sensitive, so public constants
// like KEK_SALT / INDEX_KEY_SALT and `kekId` are NOT matched) with its RHS, for the
// hardcoded-key scan (I9: "never hardcoded in a config literal").
const KEY_BINDING =
  /\b(?:const|let|var|export\s+const)\s+(dek|kek|indexKey|appKey|oldAppKey)\b\s*(?::[^=\n]+)?=\s*([^\n]+)/g

/** True if a key binding's RHS is a hardcoded literal (Buffer.from('...'), a bare string, or a ?? fallback). */
function rhsIsHardcodedKey(rhs) {
  return (
    /^\s*Buffer\.from\(\s*['"`]/.test(rhs) || // Buffer.from('<literal bytes>', ...)
    /^\s*['"`]/.test(rhs) || // = '<literal>'
    /\?\?\s*Buffer\.from\(\s*['"`]/.test(rhs) || // ?? Buffer.from('<literal>')
    /\?\?\s*['"`]/.test(rhs) // ?? '<fallback literal>'
  )
}

/** Blank comments so prose is never scanned. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** Blank quoted strings; keep only the `${...}` expressions of template literals. */
function stripLiterals(source) {
  return source
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => (m.match(/\$\{[^}]*\}/g) || []).join(' '))
}

/** Index of the `)` closing the `(` at `openIdx` (paren-depth matched). */
function matchParen(source, openIdx) {
  let depth = 0
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) return i
  }
  return -1
}

/**
 * Audit crypto src for I9 key-in-sink leaks. `files` is a list of `{ path, source }`.
 * Returns problem strings (empty = ok). Pure.
 */
export function auditNoKeyMaterialInSinks(files) {
  const problems = []
  for (const { path, source } of files) {
    const noComments = stripComments(source)
    const clean = stripLiterals(noComments)

    // 1. A raw key flowing into a log / error CALL sink.
    SINK.lastIndex = 0
    let m
    while ((m = SINK.exec(clean)) !== null) {
      // Every sink alternative ends with the opening '(' of the call.
      const openIdx = m.index + m[0].length - 1
      const closeIdx = matchParen(clean, openIdx)
      if (closeIdx === -1) continue
      const args = clean.slice(openIdx + 1, closeIdx)
      const leak = args.match(KEY)
      if (leak) {
        problems.push(
          `${path}: a log/error sink (${m[0].trim()}...) references raw key material '${leak[0]}' (I9, T11); DEK/KEK/index-key bytes must never enter a log or an error body. Log a size or a non-secret id instead.`
        )
      }
      SINK.lastIndex = closeIdx + 1
    }

    // 2. A raw key inside a bare thrown template string (`throw \`...${dek}...\``, an
    // "error" body that is not a `new X(...)` construction).
    for (const t of noComments.matchAll(/\bthrow\s+(`(?:\\.|[^`\\])*`)/g)) {
      const interps = (t[1].match(/\$\{[^}]*\}/g) || []).join(' ')
      const leak = interps.match(KEY)
      if (leak) {
        problems.push(
          `${path}: a thrown template string references raw key material '${leak[0]}' (I9, T11); a key must never appear in an error body.`
        )
      }
    }

    // 3. A secret-key-named binding assigned a HARDCODED literal (I9: never hardcode a
    // key in a config literal / a default fallback).
    for (const d of noComments.matchAll(KEY_BINDING)) {
      if (rhsIsHardcodedKey(d[2])) {
        problems.push(
          `${path}: '${d[1]}' is assigned a hardcoded key literal (I9, T11); DEK/KEK/index-key/APP_KEY material must come from the KeyProvider / env, never a source or config literal.`
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
  const problems = auditNoKeyMaterialInSinks(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-9: ${problems.length} I9 (key-in-log/error) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-crypto-invariant-9: OK (${files.length} crypto file(s); no raw DEK/KEK/index-key bytes in a log or error sink).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
