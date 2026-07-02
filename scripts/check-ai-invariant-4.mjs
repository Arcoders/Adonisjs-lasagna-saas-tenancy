#!/usr/bin/env node
// check-ai-invariant-4: the I4 structural guard for the AI satellite.
//
// I4 (packages/ai/ARCHITECTURE.md): "The model's context is tenant-pure. The
// system prompt carries no other tenant's data ... prompt injection is harmless
// by isolation." The satellite realizes this structurally: it NEVER authors a
// system-role message. Host-supplied system prompts pass through the messages
// array as-is, and retrieved documents (WS-AI-5, #10) are fenced into a `user`
// turn by buildRetrievalContext, never a system turn. So a retrieved or
// tenant-derived value can never become a trusted instruction.
//
// This scans the AI package source for a message constructed with `role:
// 'system'` (an object property, terminated by a comma or a closing brace, so the
// `role: 'system' | 'user' | 'assistant'` TYPE union and the parse-time
// allow-list are not flagged). Comments are ignored. Pure auditor exported for a
// focused unit test; the runner scans the real files via git ls-files.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// `role: 'system'` as a constructed object property (terminated by , or }), not
// the type union `role: 'system' | ...` (terminated by |) nor a set/allow-list.
const SYSTEM_ROLE_CONSTRUCT = /\brole\s*:\s*['"]system['"]\s*[,}]/

function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * Audit AI source files for I4 violations: a satellite-authored system-role
 * message. `files` is a list of `{ path, source }`. Returns problem strings
 * (empty = ok). Pure, so a unit test can drive it without a filesystem.
 */
export function auditSystemPromptPurity(files) {
  const problems = []
  for (const { path, source } of files) {
    source.split('\n').forEach((line, i) => {
      if (isComment(line)) return
      if (SYSTEM_ROLE_CONSTRUCT.test(line)) {
        problems.push(
          `${path}:${i + 1}: the satellite must not author a system-role message (I4); ` +
            `host system prompts pass through as data and retrieved content is fenced in a user turn`
        )
      }
    })
  }
  return problems
}

function run() {
  const paths = execFileSync('git', ['ls-files', 'packages/ai/src/**/*.ts'], {
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
  const problems = auditSystemPromptPurity(files)

  if (problems.length > 0) {
    console.error(
      `check-ai-invariant-4: ${problems.length} I4 (system-prompt purity) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-ai-invariant-4: OK (${files.length} AI source file(s), no satellite-authored system prompt).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
