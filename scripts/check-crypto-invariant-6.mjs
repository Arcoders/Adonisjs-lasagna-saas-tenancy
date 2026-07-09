#!/usr/bin/env node
// check-crypto-invariant-6 (scaffold): the I6 anti-regression guard for crypto.
//
// I6 (packages/crypto/ARCHITECTURE.md): "Crypto-shred destroys the ONLY copy of a
// DEK." The property (ciphertext is inert after a shred) is proved by the RED
// behavioral test resilience_shred_makes_ciphertext_inert.spec.ts; this guard is
// the STRUCTURAL scaffold that keeps the shred path honest:
//
//   - it NEVER binds/calls `unwrapDek` (no decrypted DEK can outlive the delete),
//   - it holds EXACTLY ONE DEK-destroy (`shredLive`),
//   - the WORM PENDING append precedes the delete (audit-before-delete, §6.6).
//
// Pure auditor exported for a focused unit test; the runner reads the real service.

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
 * Audit the shred module scaffold. `files` is a list of `{ path, source }`.
 * Returns problem strings (empty = ok). Pure.
 */
export function auditShredScaffold(files) {
  const problems = []
  const service = files.find((f) => f.path.endsWith('crypto_service.ts'))
  if (!service) return problems

  const body = extractMethodBody(service.source, 'shred')
  if (!body) {
    problems.push(
      `${service.path}: no async shred(...) method found (I6 scaffold cannot verify the shred path).`
    )
    return problems
  }

  if (/unwrapDek/.test(body)) {
    problems.push(
      `${service.path}: the shred path references unwrapDek (I6); a decrypted DEK must never be bound on the shred path so none can outlive the delete.`
    )
  }

  const shredLiveCount = (body.match(/shredLive\(/g) || []).length
  if (shredLiveCount !== 1) {
    problems.push(
      `${service.path}: expected EXACTLY ONE DEK-destroy (store.shredLive) on the shred path (I6), found ${shredLiveCount}.`
    )
  }

  const idxPending = body.indexOf('appendPending')
  const idxDelete = body.indexOf('shredLive')
  if (idxPending === -1) {
    problems.push(
      `${service.path}: the shred path has no WORM PENDING append (appendPending) before the delete (§6.6); an irreversible erasure must never run unaudited.`
    )
  } else if (idxDelete !== -1 && idxPending > idxDelete) {
    problems.push(
      `${service.path}: the WORM PENDING append must precede the DEK delete (audit-before-delete, §6.6), but appendPending appears after shredLive.`
    )
  }

  return problems
}

function run() {
  const files = []
  const abs = join(repoRoot, SERVICE_PATH)
  if (existsSync(abs)) files.push({ path: SERVICE_PATH, source: readFileSync(abs, 'utf8') })

  const problems = auditShredScaffold(files)
  if (problems.length > 0) {
    console.error(
      `check-crypto-invariant-6: ${problems.length} I6 (shred scaffold) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-crypto-invariant-6: OK (shred path holds one delete, no unwrapped DEK, audit-before-delete).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
