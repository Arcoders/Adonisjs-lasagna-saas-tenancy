#!/usr/bin/env node
/**
 * README link guard.
 *
 * Package READMEs render in two contexts the docs:build dead-link gate never
 * sees: the GitHub blob view and the npm package page. VitePress's dead-link gate
 * only validates links INSIDE docs/, so a README that points a relative link at a
 * file that does not exist (resolved from the README's OWN directory, the way
 * GitHub and npm resolve it) or a docs-site URL at a page that does not exist ships
 * silently. That is exactly how packages/core/README.md linked `examples/api/`
 * (which only exists at the repo root, not under packages/core) without anyone
 * noticing.
 *
 * For the root README and every packages/<x>/README.md this asserts:
 *   1. relative file/dir links resolve from THAT README's own directory, and
 *   2. docs-site links (https://arcoders.github.io/<base>/<path>) map to an existing
 *      docs/<path>.md (cleanUrls) or a docs/redirects.json entry.
 * Absolute URLs to other hosts (github.com, shields.io, npmjs.com, ...) and bare
 * anchors are not our job and are not fetched.
 *
 * Run locally and in CI: node scripts/check-readme-links.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS_BASE = 'https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/'
const REDIRECTS = JSON.parse(readFileSync(join(ROOT, 'docs/redirects.json'), 'utf8'))

// A docs-site URL anywhere in the text (covers `[text](url)`, badge link targets,
// and `<url>` autolinks). The character class stops at the markdown/HTML delimiters.
const DOCS_URL = /https:\/\/arcoders\.github\.io\/Adonisjs-lasagna-saas-tenancy\/[^\s)>\]"'`]*/g
// A markdown inline-link target: the `(...)` after `](`, optional "title" excluded.
const MD_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

// Every tracked README: the repo root one and each package's.
const tracked = execSync('git ls-files -z', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
const readmes = tracked.filter(
  (p) => p === 'README.md' || (p.startsWith('packages/') && p.endsWith('/README.md'))
)

const failures = []

/** A docs-site URL must map to a real page (cleanUrls) or a redirect entry. */
function docsLinkResolves(url) {
  let path = url.slice(DOCS_BASE.length).split('#')[0].split('?')[0].replace(/[/.,;:]+$/, '')
  if (path === '') return existsSync(join(ROOT, 'docs/index.md'))
  if (existsSync(join(ROOT, `docs/${path}.md`))) return true
  if (existsSync(join(ROOT, `docs/${path}/index.md`))) return true
  return Object.prototype.hasOwnProperty.call(REDIRECTS, `/${path}`)
}

for (const rel of readmes) {
  const dir = dirname(rel)
  const text = readFileSync(join(ROOT, rel), 'utf8')

  // 1) docs-site links resolve to a docs page or a redirect.
  for (const url of text.match(DOCS_URL) || []) {
    if (!docsLinkResolves(url)) {
      failures.push(`${rel}  → ${url}  (no matching docs/<path>.md or redirects.json entry)`)
    }
  }

  // 2) relative file/dir links resolve from this README's own directory.
  for (const m of text.matchAll(MD_LINK)) {
    const target = m[1]
    if (/^(https?:|mailto:|tel:|#)/.test(target)) continue // absolute / anchor: not our job
    const clean = target.split('#')[0].split('?')[0]
    if (clean === '') continue
    if (!existsSync(join(ROOT, dir, clean))) {
      failures.push(`${rel}  → ${target}  (relative link does not resolve from ${dir}/)`)
    }
  }
}

console.log(`check-readme-links: scanned ${readmes.length} README file(s)`)
if (failures.length > 0) {
  console.error(`\ncheck-readme-links: FAIL — ${failures.length} broken README link(s):\n`)
  for (const f of failures) console.error('  - ' + f)
  console.error(
    '\nRelative links are resolved from each README\'s own directory (the way GitHub and npm render\n' +
      'them); docs-site links must map to an existing docs/<path>.md or a docs/redirects.json entry.\n' +
      'Run `node scripts/check-readme-links.mjs` before pushing.'
  )
  process.exit(1)
}
console.log('check-readme-links: passed — every README link resolves.')
