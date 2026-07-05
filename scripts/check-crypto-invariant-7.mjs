#!/usr/bin/env node
// check-crypto-invariant-7 (scaffold): the I7 anti-regression guard for crypto.
//
// I7 (packages/crypto/ARCHITECTURE.md): "A shred is gated by governance's
// legalBasis; a legal-obligation category in retention, or an unresolvable basis,
// is REFUSED." The interlock itself is proved by the RED behavioral tests
// (security_shred_legal_hold_refused.spec.ts + security_shred_governance_absent_refused.spec.ts,
// plus the two-phase-audit half in security_shred_gated.spec.ts); this guard is the
// STRUCTURAL scaffold that keeps the gate first:
//
//   - the shred carries a fail-closed absent-governance refusal,
//   - the FIRST awaited call in shred() is the erasability resolver,
//   - the DEK delete (shredLive) is reachable only AFTER that gate,
//
// so no default-to-erase path can slip in. Pure auditor exported for a focused
// unit test; the runner reads the real service.

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVICE_PATH = 'packages/crypto/src/services/crypto_service.ts'

/** Extract the body (including braces) of an `async <name>(...)` method by brace matching. */
export function extractMethodBody(source, name) {
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
 * Audit the shred governance-gate scaffold. `files` is a list of
 * `{ path, source }`. Returns problem strings (empty = ok). Pure.
 */
export function auditShredGate(files) {
  const problems = []
  const service = files.find((f) => f.path.endsWith('crypto_service.ts'))
  if (!service) return problems

  const body = extractMethodBody(service.source, 'shred')
  if (!body) {
    problems.push(
      `${service.path}: no async shred(...) method found (I7 scaffold cannot verify the gate).`
    )
    return problems
  }

  // A fail-closed absent-governance refusal (governance absent ⇒ refuse).
  if (!/if\s*\(\s*!\s*this\.#erasabilityResolver\s*\)/.test(body)) {
    problems.push(
      `${service.path}: the shred path has no fail-closed absent-governance refusal (if (!this.#erasabilityResolver) ...) (I7); an absent resolver must refuse, never default-to-erase.`
    )
  }

  // The FIRST awaited call in shred() must be the erasability resolver.
  const firstAwait = body.indexOf('await ')
  if (firstAwait === -1) {
    problems.push(
      `${service.path}: the shred path has no awaited call (I7); the gate must be the first awaited call.`
    )
  } else {
    const after = body.slice(firstAwait + 'await '.length).trimStart()
    if (!after.startsWith('this.#erasabilityResolver')) {
      problems.push(
        `${service.path}: the FIRST awaited call in shred() must be the erasability resolver (gate-first, I7), but it is '${after.slice(0, 40)}...'.`
      )
    }
  }

  // The DEK delete must be reachable only AFTER the gate. Anchor on the AWAITED
  // resolver call, not the mention in the absent-governance `if (!...)` guard.
  const idxResolver = body.indexOf('await this.#erasabilityResolver')
  const idxDelete = body.indexOf('shredLive')
  if (idxDelete !== -1 && (idxResolver === -1 || idxDelete < idxResolver)) {
    problems.push(
      `${service.path}: the DEK delete (shredLive) must be reachable only after the governance gate (I7).`
    )
  }

  return problems
}

function run() {
  const files = []
  const abs = join(repoRoot, SERVICE_PATH)
  if (existsSync(abs)) files.push({ path: SERVICE_PATH, source: readFileSync(abs, 'utf8') })

  const problems = auditShredGate(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-7: ${problems.length} I7 (shred governance gate) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-crypto-invariant-7: OK (governance gate is the first awaited call; delete only after it).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
