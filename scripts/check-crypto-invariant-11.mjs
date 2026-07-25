#!/usr/bin/env node
// check-crypto-invariant-11: the T13 (SSRF) structural guard for @adonisjs-lasagna/crypto.
//
// Threat T13: "Point a KeyProvider HTTP backend at
// an internal URL." Mitigation (§8): "reuse safe_fetch.ts (guard.outbound_fetch); every
// KeyProvider outbound passes the SSRF pin; no second SSRF guard." A host that writes a
// custom HTTP-backed KeyProvider (AWS KMS, self-hosted Vault, a KMS proxy) must route
// EVERY outbound through core `safeFetch`, or a mis-set / attacker-influenced backend URL
// could reach loopback / RFC-1918 / cloud-metadata.
//
// This makes that discipline structural rather than documentary: the ONLY crypto src
// file allowed to reference `safeFetch` / open network egress is the SSRF-pinned base
// `services/http_key_provider.ts`, and that base MUST import and route through
// `safeFetch`. Every other src file is forbidden from raw egress (a bare `fetch(`,
// `globalThis.fetch`, `http(s).request(`, a `new Request(`, or importing an HTTP client
// like undici/axios/node-fetch), so a future provider cannot open a second, unpinned
// path. A PRESENCE FLOOR asserts the base actually exists and routes through safeFetch,
// so this guard can never pass by finding nothing (the invariant-4 false-green lesson).
//
// Pure auditor exported for a focused unit test; the runner reads the real files.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const CRYPTO_SRC_DIR = 'packages/crypto/src'

// The one file permitted to route outbound (through safeFetch). Everything else is
// forbidden from raw network egress.
const EGRESS_BASE = /(?:^|\/)services\/http_key_provider\.ts$/

// Raw-egress patterns forbidden outside the base. Lowercase `fetch(` never matches
// `safeFetch(` (the capital F), so the pinned wrapper is not self-flagged.
const FORBIDDEN = [
  ['a bare fetch() call', /(?:^|[^.\w])fetch\s*\(/],
  ['globalThis.fetch', /\bglobalThis\s*\.\s*fetch\b/],
  ['http(s).request()', /\bhttps?\s*\.\s*request\s*\(/],
  ['new Request()', /\bnew\s+Request\s*\(/],
  [
    'importing a raw HTTP client',
    /(?:from\s+|require\(\s*)['"](?:node:)?(?:http|https|undici|axios|got|node-fetch|phin|needle)['"]/,
  ],
]

/** Blank comments so prose ("route through safeFetch") is never scanned. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** The base routes correctly iff it imports from a `safe-fetch` module and calls `safeFetch`. */
function routesThroughSafeFetch(clean) {
  return /from\s+['"][^'"]*safe-fetch['"]/.test(clean) && /\bsafeFetch\s*\(/.test(clean)
}

/**
 * Audit crypto src for T13 (KeyProvider SSRF). `files` is a list of `{ path, source }`.
 * Returns problem strings (empty = ok). Pure.
 */
export function auditKeyProviderSsrf(files) {
  const problems = []
  let baseSeen = false

  for (const { path, source } of files) {
    const clean = stripComments(source)

    if (EGRESS_BASE.test(path)) {
      baseSeen = true
      if (!routesThroughSafeFetch(clean)) {
        problems.push(
          `${path}: the HttpKeyProvider egress base must import and route every outbound through core safeFetch (the T13 SSRF pin); it does not.`
        )
      }
      continue // the base is the sanctioned egress site; do not flag its safeFetch use.
    }

    for (const [label, re] of FORBIDDEN) {
      if (re.test(clean)) {
        problems.push(
          `${path}: raw network egress (${label}) is forbidden in a crypto KeyProvider path (T13). Route all outbound through the HttpKeyProvider base so core safeFetch pins it; a second, unpinned egress could reach loopback / RFC-1918 / cloud-metadata.`
        )
      }
    }
  }

  if (!baseSeen) {
    problems.push(
      `presence floor: ${CRYPTO_SRC_DIR}/services/http_key_provider.ts is missing. The SSRF-pinned egress base must exist so a host HTTP KeyProvider has a safe-by-construction path (T13); without it this guard would pass vacuously.`
    )
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
  const problems = auditKeyProviderSsrf(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-11: ${problems.length} T13 (KeyProvider SSRF) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-crypto-invariant-11: OK (${files.length} crypto file(s); all KeyProvider egress routes through core safeFetch).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
