#!/usr/bin/env node
// check-ai-invariant-1: the I1 structural guard for the AI satellite.
//
// I1 (packages/ai/ARCHITECTURE.md): "Vector indices are physically tenant-scoped
// via the active driver. Never a global public.embeddings; never a hardcoded
// tenant_<id>." An embedding can be inverted to its source text, so a leaked or
// mis-placed embeddings table is a tenant-content leak.
//
// This scans the AI package's runtime SQL surface (src + the per-tenant
// migration) for the two placement violations the invariant forbids: a global
// `public.(ai_)embeddings` table, and a `tenant_${...}` / 'tenant_' + id schema
// interpolation (which hardcodes placement instead of asking the active driver
// via tableLocation(tenant)). Comments are ignored. Pure auditor exported for a
// focused unit test; the runner scans the real files via git ls-files.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const GLOBAL_TABLE = /\bpublic\s*\.\s*(?:ai_)?embeddings\b/i
const HARDCODED_TENANT_SCHEMA = /\btenant_\$\{|["'`]\s*tenant_\s*["'`]\s*\+|\+\s*["'`]\s*tenant_/

function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * Audit AI source files for I1 placement violations. `files` is a list of
 * `{ path, source }`. Returns a list of problem strings (empty = ok). Pure, so a
 * unit test can drive it without a filesystem.
 */
export function auditVectorPlacement(files) {
  const problems = []
  for (const { path, source } of files) {
    source.split('\n').forEach((line, i) => {
      if (isComment(line)) return
      if (GLOBAL_TABLE.test(line)) {
        problems.push(
          `${path}:${i + 1}: a global embeddings table (public.embeddings) breaks I1; place it via tableLocation(tenant)`
        )
      }
      if (HARDCODED_TENANT_SCHEMA.test(line)) {
        problems.push(
          `${path}:${i + 1}: a hardcoded tenant_<id> schema breaks I1; ask the active driver via tableLocation(tenant)`
        )
      }
    })
  }
  return problems
}

function run() {
  const paths = execFileSync(
    'git',
    ['ls-files', 'packages/ai/src/**/*.ts', 'packages/ai/tenant_migrations/**/*.ts'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const files = paths.map((rel) => ({ path: rel, source: readFileSync(join(repoRoot, rel), 'utf8') }))
  const problems = auditVectorPlacement(files)

  if (problems.length > 0) {
    console.error(
      `check-ai-invariant-1: ${problems.length} I1 (vector placement) violation(s):\n  ` +
        problems.join('\n  ')
    )
    process.exit(1)
  }
  console.log(`check-ai-invariant-1: OK (${files.length} AI SQL file(s), no I1 placement violation).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
