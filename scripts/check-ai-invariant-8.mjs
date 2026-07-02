#!/usr/bin/env node
// check-ai-invariant-8: the I8 structural guard for the AI satellite.
//
// I8 (packages/ai/ARCHITECTURE.md): "Output is bounded and the system prompt
// never leaks. Guard: check-ai-invariant-8 asserts an output bound is applied on
// every response path." The only response path is the streaming spine
// (StreamExtensionService.stream, invoked as `<x>.stream.stream(...)`), which
// runs the injected `validateFragment` per fragment and aborts a leaking or
// over-cap fragment before its bytes reach the socket. This guard asserts every
// spine invocation wires a `validateFragment` output bound; the DEPTH of the
// validator (that it actually bounds / rejects) is a behavioral spec, not a
// source scan, matching the "structural only" rule for the invariant guards.
//
// Pure auditor exported for a focused unit test; the runner scans the real files
// via git ls-files.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The streaming spine call: `<something>.stream.stream(` (a StreamExtensionService
// instance's stream method), distinct from the raw `provider.stream(` producer,
// which does not take an output bound.
const SPINE_CALL = /\.stream\.stream\s*\(/
const VALIDATE_FRAGMENT = /validateFragment\s*:/
// How many lines after the spine call to search for the option (a call spans the
// target, the producer thunk and the options object across several lines).
const WINDOW = 30

function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * Audit AI source files for I8 violations: a streaming-spine invocation with no
 * `validateFragment` output bound. `files` is a list of `{ path, source }`.
 * Returns problem strings (empty = ok). Pure, so a unit test can drive it.
 */
export function auditOutputBounds(files) {
  const problems = []
  for (const { path, source } of files) {
    const lines = source.split('\n')
    lines.forEach((line, i) => {
      if (isComment(line)) return
      if (!SPINE_CALL.test(line)) return
      const window = lines.slice(i, i + WINDOW).join('\n')
      if (!VALIDATE_FRAGMENT.test(window)) {
        problems.push(
          `${path}:${i + 1}: a streaming response path with no validateFragment output bound (I8)`
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

  const files = paths.map((rel) => ({ path: rel, source: readFileSync(join(repoRoot, rel), 'utf8') }))
  const problems = auditOutputBounds(files)

  if (problems.length > 0) {
    console.error(
      `check-ai-invariant-8: ${problems.length} I8 (output bound) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(
    `check-ai-invariant-8: OK (${files.length} AI source file(s), every streaming path is output-bounded).`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
