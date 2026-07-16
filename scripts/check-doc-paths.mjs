#!/usr/bin/env node
/**
 * Doc-path guard.
 *
 * The docs live under docs/{start,guides,reference}/ after the 1.0 restructure.
 * Plenty of NON-markdown files reference doc files by path — build scripts, the
 * benchmark harness, GitHub workflows, unit tests, source JSDoc, package
 * READMEs/CHANGELOGs. VitePress's dead-link gate only checks links INSIDE docs/,
 * so a stale path in any of those other files ships silently and then breaks a
 * script or a CI job at runtime (which is exactly how a guard script kept reading
 * a deleted page under the old nested docs directory after the move).
 *
 * This guard scans every tracked text file EXCEPT the docs markdown itself (the
 * dead-link gate owns that) and asserts:
 *   1. nothing references the deleted nested docs directory, and
 *   2. every `docs/<path>.md` literal resolves to a real file on disk.
 *
 * Run it locally and in CI: `node scripts/check-doc-paths.mjs`.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SCAN_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.sh',
  '.edge',
  '.stub',
])

const SKIP_FILES = new Set([
  'package-lock.json', // huge, lockfile, no authored doc references
  basename(fileURLToPath(import.meta.url)), // this guard names the patterns it hunts for
])

// The deleted nested directory; built by concatenation so this file never holds
// the literal token it forbids (belt-and-suspenders with the SKIP_FILES self-skip).
const STALE_DIR = 'docs/' + 'docs/'
// A `docs/<path>.md` literal. The lookbehind lets `../docs/x.md` match while
// `subdocs/x.md` does not; non-greedy so a trailing `#anchor` is excluded.
const DOC_MD = /(?<![\w-])docs\/[\w./-]+?\.md/g

// Only validate TRACKED files (what actually ships): `git ls-files` respects
// .gitignore, so build output, coverage, node_modules and per-run benchmark
// results never enter the scan.
const tracked = execSync('git ls-files -z', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

const failures = []
let scanned = 0

for (const rel of tracked) {
  if (SKIP_FILES.has(basename(rel))) continue
  if (!SCAN_EXT.has(extname(rel))) continue
  // The docs markdown corpus is the dead-link gate's job; redirects.json holds old
  // URLs on purpose. Skip both; scan every other text file (including non-md under docs/).
  if (rel.startsWith('docs/') && rel.endsWith('.md')) continue
  if (rel === 'docs/redirects.json') continue

  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
  scanned++
  lines.forEach((line, i) => {
    if (line.includes(STALE_DIR)) {
      failures.push(`${rel}:${i + 1}  references the deleted nested docs directory ("${STALE_DIR}")`)
    }
    for (const match of line.matchAll(DOC_MD)) {
      const p = match[0]
      if (p.includes(STALE_DIR)) continue // already reported by the directory check
      if (!existsSync(join(ROOT, p))) {
        failures.push(`${rel}:${i + 1}  → ${p} (no such file)`)
      }
    }
  })
}

console.log(`check-doc-paths: scanned ${scanned} files`)
if (failures.length > 0) {
  console.error(`\ncheck-doc-paths: FAIL — ${failures.length} stale documentation path reference(s):\n`)
  for (const f of failures) console.error('  - ' + f)
  console.error(
    '\nThe docs are organised under docs/{start,guides,reference}/. Repoint each reference to its' +
      '\nnew path (docs/redirects.json maps the old URL → new). This guard runs in CI; run it locally' +
      '\nwith `node scripts/check-doc-paths.mjs` before pushing any docs move.'
  )
  process.exit(1)
}
console.log('check-doc-paths: passed — every documentation path reference resolves.')
