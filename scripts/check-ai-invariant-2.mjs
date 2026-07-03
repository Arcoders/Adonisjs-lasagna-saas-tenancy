#!/usr/bin/env node
// check-ai-invariant-2: the I2 structural guard for the AI satellite.
//
// I2 (packages/ai/ARCHITECTURE.md): "Conversation memory is encrypted at rest
// with tenant-bound keys and TTL-bounded ... Guard: check-ai-invariant-2 asserts
// encrypt on every memory write path and HMAC validation on every session read."
// Memory is a novel exfiltration vector: it persists tenant content across
// requests, so it must be encrypted at rest AND its sessions must be unforgeable.
//
// Three structural rules, low-false-positive by construction:
//
//   1. Memory/context turns are DATA, never instructions: the memory module and
//      the context builder never CONSTRUCT `role: 'system'` (a poisoned memory
//      turn replayed as a system directive could rewrite the model's
//      instructions, #1/#10). Replayed memory is user/assistant only.
//   2. Encryption on every write: the memory service references `encryptMemory(`
//      (the injected kernel writeSecret), so a turn is never RPUSHed in plaintext.
//   3. HMAC validation on every session read: the memory service references
//      `timingSafeEqual` (the session-token verification, G6).
//
// Comments are ignored. Pure auditor exported for a focused unit test; the runner
// scans the real files via git ls-files.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The memory files whose turn construction and crypto discipline this guard pins.
// The service is where memory is written/read; the context builder is where it is
// replayed into a prompt.
const MEMORY_FILES = [
  'packages/ai/src/services/conversation_memory_service.ts',
  'packages/ai/src/gateway/context_builder.ts',
]
const SERVICE_FILE = 'conversation_memory_service.ts'

// Object-literal construction of a system-role turn (not a comparison like
// `role === 'system'`, and not a comment): `role: 'system'`.
const SYSTEM_ROLE_CONSTRUCT = /\brole\s*:\s*['"`]system['"`]/
const ENCRYPT_MEMORY_CALL = /\bencryptMemory\s*\(/
const TIMING_SAFE_EQUAL = /\btimingSafeEqual\s*\(/

function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * Audit the AI memory files for I2 violations. `files` is a list of
 * `{ path, source }`. Returns a list of problem strings (empty = ok). Pure, so a
 * unit test can drive it without a filesystem.
 */
export function auditMemoryInvariant(files) {
  const problems = []
  for (const { path, source } of files) {
    source.split('\n').forEach((line, i) => {
      if (isComment(line)) return
      if (SYSTEM_ROLE_CONSTRUCT.test(line)) {
        problems.push(
          `${path}:${i + 1}: memory/context turns must never be constructed with role:'system' (I2/#1/#10); replay memory as user/assistant DATA only`
        )
      }
    })

    if (path.endsWith(SERVICE_FILE)) {
      if (!ENCRYPT_MEMORY_CALL.test(source)) {
        problems.push(
          `${path}: the memory write path must encrypt via encryptMemory( (I2: encryption on every memory write)`
        )
      }
      if (!TIMING_SAFE_EQUAL.test(source)) {
        problems.push(
          `${path}: the session read path must HMAC-validate via timingSafeEqual (I2: HMAC on every session read, G6)`
        )
      }
    }
  }
  return problems
}

function run() {
  const paths = execFileSync('git', ['ls-files', ...MEMORY_FILES], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const files = paths.map((rel) => ({
    path: rel,
    source: readFileSync(join(repoRoot, rel), 'utf8'),
  }))
  const problems = auditMemoryInvariant(files)

  if (problems.length > 0) {
    console.error(
      `check-ai-invariant-2: ${problems.length} I2 (conversation memory) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-ai-invariant-2: OK (${files.length} AI memory file(s), encryption + session-HMAC + data-role only).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
