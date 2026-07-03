#!/usr/bin/env node
// check-ai-no-provider-prompt-cache: the "no provider prompt-cache" anti-drift guard (WS-AI-8, H2).
//
// A provider-side prompt cache (Anthropic `cache_control`, OpenAI `prompt_cache_key`,
// etc.) that is NOT namespaced per tenant is a cross-tenant leak vector: tenant A's
// cached prompt prefix could serve tenant B. The AI satellite deliberately does NOT
// use provider prompt caching today (verified: the model-provider request builders
// send only {model, max_tokens, messages, stream}). This guard pins that invariant so
// it cannot silently break.
//
// If you intentionally add provider prompt caching, you MUST (1) namespace the cache
// key per tenant (a tenant-salted key so tenant A's cached prefix can never serve
// tenant B) and (2) update this guard's allow-list with that justification. Adding a
// bare cache directive without both is the exact drift this guard exists to stop.
//
// Comments are ignored. Pure auditor exported for a focused unit test; the runner
// scans the real model-provider files via git ls-files.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// Only the model-provider request builders. The AdonisJS provider (packages/ai/providers)
// is DI wiring, not an outbound request builder; tests/stubs carry fixtures.
const SCAN_GLOBS = ['packages/ai/src/providers/**/*.ts']

// Provider prompt-cache directives, by SDK. Each is a request-side caching knob that
// must be tenant-namespaced before it is ever sent. None exist in the package today.
const CACHE_DIRECTIVES = [
  /\bcache_control\b/,
  /\bcacheControl\b/,
  /\bprompt_cache_key\b/,
  /\bpromptCacheKey\b/,
  /\bcache_creation\b/,
  /\bno-cache\b/,
]

function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * Audit the model-provider files for a provider prompt-cache directive. `files` is a
 * list of `{ path, source }`. Returns a list of problem strings (empty = ok). Pure,
 * so a unit test can drive it without a filesystem.
 */
export function auditNoProviderPromptCache(files) {
  const problems = []
  for (const { path, source } of files) {
    source.split('\n').forEach((line, i) => {
      if (isComment(line)) return
      const hit = CACHE_DIRECTIVES.find((d) => d.test(line))
      if (hit) {
        problems.push(
          `${path}:${i + 1}: a provider prompt-cache directive (${hit.source}) must be tenant-namespaced ` +
            `before use and then allow-listed here (H2): an un-salted provider cache can serve tenant A's ` +
            `cached prefix to tenant B`
        )
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
  const problems = auditNoProviderPromptCache(files)

  if (problems.length > 0) {
    console.error(
      `check-ai-no-provider-prompt-cache: ${problems.length} un-namespaced provider-cache directive(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-ai-no-provider-prompt-cache: OK (${files.length} model-provider file(s); no provider prompt-cache directive).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
