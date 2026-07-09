import { test } from '@japa/runner'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../../../../satellite-test-kit/src/repo_root.js'

/**
 * Docs-integrity guard #2 of 3: every top-level option of `MultitenancyConfig`
 * (the shape an app passes to `defineConfig`) must be documented somewhere on
 * the docs site.
 *
 * The "declared" set is parsed straight from the interface in
 * src/types/config.ts — top level only, since nested keys (e.g. `circuitBreaker.threshold`)
 * are documented under their parent and going deeper invites false positives. The
 * "documented" set is the whole docs/ markdown corpus: a key counts as documented
 * when it appears as an inline-code token (`` `resolver` ``, `` `resolver.cache.enabled` ``)
 * or as a config property (`hooks:` in a code block). Cross-cutting seams live on
 * their own pages (hooks → hooks.md, compliance → compliance.md), so the corpus is
 * the whole site, not just configuration.md.
 *
 * Fails the moment a new top-level config option ships undocumented.
 */

const REPO_ROOT = repoRoot(import.meta.url)
const CONFIG_TS = join(REPO_ROOT, 'packages', 'core', 'src', 'types', 'config.ts')
const DOCS_DIR = join(REPO_ROOT, 'docs')

/** Top-level keys intentionally not documented (live debt ledger; keep justified). */
const ALLOWED_UNDOCUMENTED = new Set<string>([])

/** Strip block + line comments so JSDoc property mentions don't pollute the parse. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Pull the body of `export interface MultitenancyConfig { ... }` by brace matching. */
function interfaceBody(src: string): string {
  const start = src.indexOf('interface MultitenancyConfig')
  if (start === -1) throw new Error('MultitenancyConfig interface not found in config.ts')
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error('Unbalanced braces parsing MultitenancyConfig')
}

/** Property names declared at the top level of the interface body (depth 0). */
function topLevelKeys(body: string): string[] {
  const keys: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const m = line.match(/^\s*([a-zA-Z_]\w*)\??:/)
      if (m) keys.push(m[1]!)
    }
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') depth = Math.max(0, depth - 1)
    }
  }
  return keys
}

/** Concatenate every markdown file under docs/. */
function docsCorpus(dir: string): string {
  let out = ''
  for (const entry of readdirSync(dir)) {
    if (entry === '.vitepress' || entry === 'node_modules') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out += docsCorpus(full)
    else if (entry.endsWith('.md')) out += '\n' + readFileSync(full, 'utf8')
  }
  return out
}

function isDocumented(key: string, corpus: string): boolean {
  // Inline-code token: `key`, `key.sub`, `key?`, `key:` …
  const asToken = new RegExp('`' + key + '[.`?:]')
  // Config property in a code block: `key:` / `key?:` at a word boundary.
  const asProperty = new RegExp('\\b' + key + '\\s*\\??:')
  return asToken.test(corpus) || asProperty.test(corpus)
}

test.group('Docs integrity: configuration', () => {
  test('every top-level MultitenancyConfig option is documented', ({ assert }) => {
    const keys = topLevelKeys(interfaceBody(stripComments(readFileSync(CONFIG_TS, 'utf8'))))
    const corpus = docsCorpus(DOCS_DIR)

    assert.isAbove(keys.length, 10, 'expected to parse the MultitenancyConfig top-level keys')

    const undocumented = keys
      .filter((k) => !ALLOWED_UNDOCUMENTED.has(k))
      .filter((k) => !isDocumented(k, corpus))

    assert.deepEqual(
      undocumented,
      [],
      [
        'These top-level config options are declared in src/types/config.ts but not',
        'documented anywhere under docs/:',
        ...undocumented.map((k) => `  - ${k}`),
        '',
        'Document the option (configuration.md or the relevant feature page), or add it',
        'to ALLOWED_UNDOCUMENTED in this spec with a justification.',
      ].join('\n')
    )
  })
})
