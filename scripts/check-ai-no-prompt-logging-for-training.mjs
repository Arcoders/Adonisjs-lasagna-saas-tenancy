#!/usr/bin/env node
// check-ai-no-prompt-logging-for-training: the #15 (no-train) structural guard.
//
// packages/ai/ARCHITECTURE.md #15 ("PII to provider / training"): the mitigation
// is a residency allow-list ("local-only") PLUS "a check-ai-no-prompt-logging-for-
// training guard". The training/exfiltration risk is that a prompt, response,
// retrieved document, or decrypted memory turn is written to an application LOG,
// where it is durable, un-erasable, and can be scooped into a training set. Audit
// non-PII is pinned separately (check-ai-invariant-5); metrics are integers by
// type. This guard pins the LOG surface:
//
//   1. No `console.*` anywhere in the AI package: logging goes through the
//      injected, metadata-only logger, never a raw console (which bypasses
//      redaction and structured sinks).
//   2. No content token flows into a log/warn sink. On any line that calls a
//      logger / console / injected `warn`, a content identifier (prompt,
//      messages, .content, plaintext, query) must not appear as an argument or a
//      `${...}` interpolation. Quoted string literals are stripped first (a
//      message like 'query too long' is fine), and a template literal keeps only
//      its `${...}` expressions, so a static word never trips it but a logged
//      `${prompt}` does.
//
// Comments are ignored. Pure auditor exported for a focused unit test; the runner
// scans the real files via git ls-files.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The AI code that handles prompts/responses/documents/memory. Tests, stubs and
// migrations are excluded (they carry fixtures, not runtime log sinks).
const SCAN_GLOBS = ['packages/ai/src/**/*.ts', 'packages/ai/providers/**/*.ts']

const CONSOLE_CALL = /\bconsole\s*\.\s*\w+/
const SINK_CALL = /\bconsole\s*\.|\blogger\s*\.|\bwarn\s*\??\.?\s*\(/
const CONTENT_TOKENS = [/\bprompt\b/, /\bmessages\b/, /\.content\b/, /\bplaintext\b/, /\bquery\b/]

function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** Remove quoted string literals; keep only the `${...}` interpolations of template literals. */
function stripLiterals(line) {
  let s = line.replace(/'(\\.|[^'\\])*'/g, ' ').replace(/"(\\.|[^"\\])*"/g, ' ')
  s = s.replace(/`(\\.|[^`\\])*`/g, (m) => (m.match(/\$\{[^}]*\}/g) || []).join(' '))
  return s
}

/**
 * Audit the AI files for #15 (no-train) log-leak violations. `files` is a list of
 * `{ path, source }`. Returns a list of problem strings (empty = ok). Pure, so a
 * unit test can drive it without a filesystem.
 */
export function auditNoPromptLogging(files) {
  const problems = []
  for (const { path, source } of files) {
    source.split('\n').forEach((line, i) => {
      if (isComment(line)) return
      const bare = stripLiterals(line)
      if (CONSOLE_CALL.test(bare)) {
        problems.push(
          `${path}:${i + 1}: no console.* in the AI package (#15): use the injected metadata-only logger, never a raw console`
        )
      }
      if (SINK_CALL.test(bare)) {
        const hit = CONTENT_TOKENS.find((t) => t.test(bare))
        if (hit) {
          problems.push(
            `${path}:${i + 1}: a log/warn sink references content (${hit.source}) (#15): prompts/responses/documents/memory must never be logged (training/exfiltration risk)`
          )
        }
      }
    })
  }
  return problems
}

function expandGlobs(globs) {
  return execFileSync('git', ['ls-files', ...globs], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function run() {
  const paths = expandGlobs(SCAN_GLOBS)
  const files = paths.map((rel) => ({ path: rel, source: readFileSync(join(repoRoot, rel), 'utf8') }))
  const problems = auditNoPromptLogging(files)

  if (problems.length > 0) {
    console.error(
      `check-ai-no-prompt-logging-for-training: ${problems.length} #15 (no-train) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-ai-no-prompt-logging-for-training: OK (${files.length} AI file(s); no console, no content in any log sink).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
