#!/usr/bin/env node
// check-crypto-invariant-4: the I4 structural guard for @adonisjs-lasagna/crypto.
//
// I4 (packages/crypto/ARCHITECTURE.md §4): "Each (subject x category) derives its own
// DEK, and each secret class its own HKDF context; keys never overlap" — the
// confused-deputy resistance (T7): a value sealed for one (subject x category) cannot
// open under another. In the implementation the domain separation is realized two ways,
// and this guard pins both structurally:
//
//   FIELD DATA — sealed by the per-row DEK, never a shared or context-derived key.
//     crypto_service.ts seals/opens field values with sealV2WithKey/openV2WithKey keyed
//     by the DEK (`dek` / `live.dek`), which is a distinct RANDOM key per (subject x
//     category) drawn from the store, NOT derived from a category context. So the
//     service must NOT feed a category/context through HKDF to make a field key
//     (`hkdfSync` in crypto_service would collapse the per-row separation to a shared
//     derived key). Two rows' ciphertexts cannot cross-open because their DEKs differ.
//
//   DERIVED KEYS — domain-separated by DISTINCT HKDF salts + a category-bound index key.
//     env_key_provider.ts derives the KEK, the kek-id tag, and the blind-index key from
//     APP_KEY via HKDF; each uses a DISTINCT salt so a category's index key can never be
//     the same bytes as the KEK (or the kek-id). The blind-index key additionally binds
//     `category` into its HKDF info, so distinct categories derive distinct index keys
//     (the "category -> HKDF context is injective" clause).
//
// Pure auditor exported for a focused unit test; the runner reads the real files.

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVICE_MATCH = 'services/crypto_service.ts'
const PROVIDER_MATCH = 'services/env_key_provider.ts'
const FILES = [`packages/crypto/${SERVICE_MATCH}`, `packages/crypto/${PROVIDER_MATCH}`]

/** Strip comments so prose naming a token / hkdf is never a false positive. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** Extract the `{...}` body of an `async <name>(` / `<name>(` by brace matching. */
function extractBody(source, name) {
  const sigIdx =
    source.indexOf(`async ${name}(`) !== -1
      ? source.indexOf(`async ${name}(`)
      : source.indexOf(`${name}(`)
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

/**
 * Audit the I4 domain-separation surface. `files` is a list of `{ path, source }`.
 * Returns problem strings (empty = ok). Pure.
 */
export function auditDomainSeparation(files) {
  const problems = []
  const find = (m) => files.find((f) => f.path.replace(/\\/g, '/').includes(m))

  // FIELD DATA: crypto_service seals/opens keyed by the per-row DEK, no HKDF field key.
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
    if (/\bhkdfSync\b/.test(clean)) {
      problems.push(
        `${service.path}: the field-encryption service must NOT derive a field key via hkdfSync (I4/T7); a field value is keyed by its own random per-(subject x category) DEK, so a context-derived shared key would collapse the confused-deputy separation.`
      )
    }
  }

  // DERIVED KEYS: distinct HKDF salts + a category-bound blind-index key.
  const provider = find(PROVIDER_MATCH)
  if (provider) {
    const clean = stripComments(provider.source)
    const salts = new Map()
    const saltRe = /const\s+(\w*_SALT)\s*=\s*Buffer\.from\(\s*'([^']*)'/g
    let m
    while ((m = saltRe.exec(clean)) !== null) salts.set(m[1], m[2])
    const values = [...salts.values()]
    if (new Set(values).size !== values.length) {
      problems.push(
        `${provider.path}: the HKDF salts (${[...salts.keys()].join(', ')}) must be pairwise DISTINCT (I4); a shared salt would let a category's index key derive the same bytes as the KEK.`
      )
    }
    const deriveIndex = extractBody(clean, 'deriveIndexKey')
    if (!deriveIndex) {
      problems.push(
        `${provider.path}: no deriveIndexKey(...) found (I4); the blind-index key must be category-scoped.`
      )
    } else if (!/\bcategory\b/.test(deriveIndex)) {
      problems.push(
        `${provider.path}: deriveIndexKey must bind 'category' into its HKDF derivation (I4); distinct categories must derive distinct index keys (an injective category -> key map).`
      )
    }
  }

  return problems
}

function run() {
  const files = []
  for (const rel of FILES) {
    const abs = join(repoRoot, rel)
    if (existsSync(abs)) files.push({ path: rel, source: readFileSync(abs, 'utf8') })
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
    'check-crypto-invariant-4: OK (field seal keyed by the per-row DEK; distinct HKDF salts; category-bound blind-index key).'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
