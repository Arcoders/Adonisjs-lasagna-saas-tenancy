#!/usr/bin/env node
// check-crypto-invariant-4: the I4 structural guard for @adonisjs-lasagna/crypto.
//
// I4 (packages/crypto/ARCHITECTURE.md §4): "Each (subject x category) derives its own
// DEK, and each secret class its own HKDF context; keys never overlap" — the
// confused-deputy resistance (T7): a value sealed for one (subject x category) cannot
// open under another. The domain separation is realized two ways; this guard pins both:
//
//   FIELD DATA — sealed by the per-row DEK, never a shared or context-derived key.
//     A field value is keyed by its own random per-(subject x category) DEK (from the
//     store), NOT an HKDF-derived key, so NO crypto src file EXCEPT the KeyProvider may
//     call `hkdfSync` (the KEK / kek-id / index-key derivations live only there); a
//     derivation anywhere else — including a helper under src/internal/ — would be a
//     shared field key. crypto_service seals/opens with sealV2WithKey/openV2WithKey
//     keyed by `dek` / `live.dek`.
//
//   DERIVED KEYS — domain-separated by DISTINCT frozen HKDF salts + a category-bound
//     index key. The KeyProvider's frozen Buffer.from(...) byte constants (the KEK
//     salt, the kek-id salt, the index-key salt, the kek-id info) must be pairwise
//     DISTINCT so a category's index key can never be the same bytes as the KEK, and
//     the blind-index derivation must feed `category` into its hkdfSync `info`
//     argument, so distinct categories derive distinct index keys (injective).
//
// Pure auditor exported for a focused unit test; the runner reads the real files.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const CRYPTO_SRC_DIR = 'packages/crypto/src'
const SERVICE_MATCH = 'src/services/crypto_service.ts'
// The ONE sanctioned HKDF derivation site (the KEK / kek-id / index-key hierarchy).
const PROVIDER_MATCH = 'src/services/env_key_provider.ts'

/** Strip comments so prose naming a token / hkdf is never a false positive. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Extract the `{...}` body of a definition named `name` — an `async name(` /
 * `name(` method, an `async function name(` / `function name(`, or (last resort) the
 * first `name(` call site — by brace matching. Definition forms are tried first so a
 * call site never mis-anchors the extraction to the wrong body.
 */
function extractBody(source, name) {
  let sigIdx = -1
  for (const form of [
    `async function ${name}(`,
    `function ${name}(`,
    `async ${name}(`,
    `${name}(`,
  ]) {
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

/** Split a call-argument string on TOP-LEVEL commas (paren/brace/bracket aware). */
function splitArgs(argText) {
  const args = []
  let depth = 0
  let start = 0
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      args.push(argText.slice(start, i))
      start = i + 1
    }
  }
  args.push(argText.slice(start))
  return args.map((a) => a.trim())
}

/** The paren-matched argument text of the FIRST `name(` call in `source`, or null. */
function callArgs(source, name) {
  const idx = source.indexOf(`${name}(`)
  if (idx === -1) return null
  const open = idx + name.length
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) return splitArgs(source.slice(open + 1, i))
  }
  return null
}

/**
 * Audit the I4 domain-separation surface. `files` is a list of `{ path, source }`.
 * Returns problem strings (empty = ok). Pure.
 */
export function auditDomainSeparation(files) {
  const problems = []
  const find = (m) => files.find((f) => f.path.replace(/\\/g, '/').includes(m))

  // FIELD DATA: no HKDF-derived field key ANYWHERE in crypto src except the KeyProvider.
  for (const file of files) {
    const rel = file.path.replace(/\\/g, '/')
    if (rel.includes(PROVIDER_MATCH)) continue
    if (/\bhkdfSync\b/.test(stripComments(file.source))) {
      problems.push(
        `${file.path}: hkdfSync appears outside the KeyProvider (I4/T7); a field value is keyed by its own random per-(subject x category) DEK, so deriving a key here (or in a helper it imports) would collapse the confused-deputy separation. HKDF lives only in ${PROVIDER_MATCH}.`
      )
    }
  }

  // FIELD DATA: crypto_service seals/opens keyed by the per-row DEK.
  const service = find(SERVICE_MATCH)
  if (service) {
    const clean = stripComments(service.source)
    const seal = clean.match(/sealV2WithKey\(\s*[^,]+,\s*([^,]+?)\s*,/)
    const open = clean.match(/openV2WithKey\(\s*[^,]+,\s*([^,)]+?)\s*\)/)
    if (!seal || !/\bdek\b/i.test(seal[1])) {
      problems.push(
        `${service.path}: the field seal (sealV2WithKey) must be keyed by the per-row DEK (I4/T7), not a shared/derived key.`
      )
    }
    if (!open || !/\bdek\b/i.test(open[1])) {
      problems.push(
        `${service.path}: the field open (openV2WithKey) must be keyed by the per-row DEK (I4/T7), not a shared/derived key.`
      )
    }
  }

  // DERIVED KEYS: distinct frozen byte constants + a category-bound blind-index key.
  const provider = find(PROVIDER_MATCH)
  if (provider) {
    const clean = stripComments(provider.source)

    // Every frozen Buffer.from('...') byte constant (any quote style, const/let/var)
    // must be pairwise DISTINCT — a shared salt would let a category's index key derive
    // the same bytes as the KEK. Collecting ALL of them (not just `*_SALT` names) closes
    // the naming/quote-style blind spot.
    const consts = new Map()
    const constRe = /(?:const|let|var)\s+(\w+)\s*=\s*Buffer\.from\(\s*(['"`])((?:(?!\2).)*)\2/g
    let m
    while ((m = constRe.exec(clean)) !== null) consts.set(m[1], m[3])
    const byValue = new Map()
    for (const [name, value] of consts) {
      const dup = byValue.get(value)
      if (dup) {
        problems.push(
          `${provider.path}: the KeyProvider byte constants '${dup}' and '${name}' are identical (I4); the KEK / kek-id / index-key salts (and infos) must be pairwise DISTINCT so a category's index key never shares the KEK's keyspace.`
        )
      } else {
        byValue.set(value, name)
      }
    }

    // The blind-index derivation must feed `category` into its hkdfSync `info` argument,
    // not merely mention the token: distinct categories must derive distinct index keys.
    const deriveIndex = extractBody(clean, 'deriveIndexKey')
    if (!deriveIndex) {
      problems.push(
        `${provider.path}: no deriveIndexKey(...) found (I4); the blind-index key must be category-scoped.`
      )
    } else {
      const hkdfArgs = callArgs(deriveIndex, 'hkdfSync')
      const info = hkdfArgs && hkdfArgs.length >= 4 ? hkdfArgs[3] : null
      // `category` must appear in the info expression directly, OR be passed into a
      // helper that itself consumes it (e.g. `indexKeyInfo(tenantId, category)` whose
      // body length-delimits the pair).
      const infoBindsCategory = (() => {
        if (!info || !/\bcategory\b/.test(info)) return false
        const helper = info.match(/([A-Za-z_$][\w$]*)\s*\(/)
        if (!helper) return true // category appears directly in the info expression
        const helperBody = extractBody(clean, helper[1])
        return helperBody === null || /\bcategory\b/.test(helperBody)
      })()
      if (!infoBindsCategory) {
        problems.push(
          `${provider.path}: deriveIndexKey must feed 'category' into its hkdfSync info argument (I4); distinct categories must derive distinct index keys (an injective category -> key map).`
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
  // Fail loud if the two load-bearing files vanished (a path typo must not pass green).
  for (const match of [SERVICE_MATCH, PROVIDER_MATCH]) {
    if (!files.some((f) => f.path.replace(/\\/g, '/').includes(match))) {
      console.error(`check-crypto-invariant-4: expected source file matching '${match}' not found.`)
      process.exit(1)
    }
  }
  const problems = auditDomainSeparation(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-4: ${problems.length} I4 (domain separation) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-crypto-invariant-4: OK (${files.length} crypto file(s); field seal keyed by the per-row DEK, HKDF only in the KeyProvider, distinct salts, category-bound blind-index key).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
