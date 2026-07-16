#!/usr/bin/env node
// check-ai-invariant-7: the I7 structural guard for the AI satellite.
//
// I7 (packages/ai/ARCHITECTURE.md): "Tool / function calling is tenant-scoped and
// least-privilege." Tool calling is the one path where the model's output causes the
// host's own code to run against the tenant's tables, so the whole invariant rests on
// four structural facts inside the executor. Each is cheap to delete by accident and
// silent when deleted — the loop keeps working, the tests that matter still pass, and
// the isolation is simply gone. That is what this scan pins.
//
//  1. The handler runs INSIDE `runScoped(tenant, ...)`. A handler awaited outside the
//     bind would query whatever schema happened to be ambient.
//  2. The ambient scope is re-asserted BEFORE the bind (`assertActiveToolScope` called
//     ahead of `runScoped`). Reading it after the bind compares the just-set scope to
//     itself — a tautology that passes forever while checking nothing. The ORDER is
//     the invariant, so the scan enforces line order, not mere presence.
//  3. The registry is default-deny: `resolveToolRegistry` returns [] for absent config
//     rather than falling back to some ambient set.
//  4. Authorization is consulted per call (`authorizeToolScope`) before the handler.
//
// Pure auditor exported for a focused unit test; the runner scans the real files via
// git ls-files. Mirrors check-ai-invariant-1/4/5/8.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const EXECUTOR = 'packages/ai/src/services/tool_executor.ts'
const GATE = 'packages/ai/src/gateway/tool_gate.ts'

function stripComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const t = line.trim()
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line
    })
    .join('\n')
}

/** First 0-based line index matching `re`, or -1. Comment lines are blanked first. */
function lineOf(source, re) {
  const lines = stripComments(source).split('\n')
    return lines.findIndex((line) => re.test(line))
}

/**
 * Audit the AI tool path for I7 violations. `files` is a list of `{ path, source }`
 * covering at least the executor and the gate. Returns problem strings (empty = ok).
 * Pure, so a unit test can drive it without a filesystem.
 */
export function auditToolScoping(files) {
  const problems = []
  const byPath = new Map(files.map((f) => [f.path, f.source]))

  const executor = byPath.get(EXECUTOR)
  if (executor === undefined) {
    problems.push(
      `${EXECUTOR}: missing. I7 is enforced by the tool executor; if it moved, update this guard.`
    )
  } else {
    const clean = stripComments(executor)

    // (1) the handler runs inside the tenancy bind
    if (!/runScoped\s*\(/.test(clean)) {
      problems.push(
        `${EXECUTOR}: no runScoped(tenant, ...) call; a tool handler MUST run inside the ` +
          `active tenancy scope (I7), or it queries whatever schema is ambient`
      )
    }

    // (2) the I7 re-assert exists AND precedes the bind
    const assertAt = lineOf(executor, /assertActiveToolScope\s*\(/)
    const bindAt = lineOf(executor, /runScoped\s*\(/)
    if (assertAt === -1) {
      problems.push(
        `${EXECUTOR}: no assertActiveToolScope(...) call; the confused-deputy re-assert (I7) is ` +
          `what refuses a call arriving under another tenant's ambient scope`
      )
    } else if (bindAt !== -1 && assertAt > bindAt) {
      problems.push(
        `${EXECUTOR}:${assertAt + 1}: assertActiveToolScope must be called BEFORE runScoped ` +
          `(line ${bindAt + 1}). Reading the active scope inside the bind compares it to itself — ` +
          `a tautology that passes forever while checking nothing`
      )
    }

    // (4) per-call authorization precedes the handler
    if (!/authorizeToolScope\s*\(/.test(clean)) {
      problems.push(
        `${EXECUTOR}: no authorizeToolScope(...) call; every tool call must be authorized ` +
          `per call (I7, least-privilege), not merely resolved from the registry`
      )
    }
  }

  const gate = byPath.get(GATE)
  if (gate === undefined) {
    problems.push(`${GATE}: missing. I7's default-deny registry lives here; update this guard.`)
  } else {
    const clean = stripComments(gate)
    // (3) default-deny: absent tools config yields no tools, never an ambient fallback.
    if (!/if\s*\(\s*!toolsConfig\s*\)\s*return\s*\[\]/.test(clean)) {
      problems.push(
        `${GATE}: resolveToolRegistry must return [] when config.ai.tools is absent ` +
          `(default-deny, I7). A fallback to any ambient tool set would offer tools the ` +
          `host never opted into`
      )
    }
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
  const problems = auditToolScoping(files)

  if (problems.length > 0) {
    console.error(
      `check-ai-invariant-7: ${problems.length} I7 (tool scoping) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-ai-invariant-7: OK (tool handler bound in tenancy.run, scope re-asserted before the ` +
      `bind, registry default-deny, per-call authorization).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
