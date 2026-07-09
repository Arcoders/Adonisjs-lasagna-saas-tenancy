import { test } from '@japa/runner'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../../../../satellite-test-kit/src/repo_root.js'

/**
 * Docs-integrity guard for the site NAVIGATION. The dead-link gate only sees
 * broken links; a page that exists but is wired into no menu ships invisible.
 * That bug class bit twice: the AI satellite guide had no sidebar entry, and
 * the reporting guide was absent from the satellites overview page. This spec
 * pins both seams so a third recurrence fails the suite instead of shipping.
 *
 * The VitePress config is parsed TEXTUALLY (the check-isthmus.mjs pattern):
 * importing docs/.vitepress/config.ts would drag vitepress + mermaid into the
 * unit suite. Tripwires below fail loudly if the parse drifts from the file.
 */

const REPO_ROOT = repoRoot(import.meta.url)
const CONFIG_PATH = join(REPO_ROOT, 'docs', '.vitepress', 'config.ts')
const OVERVIEW_PATH = join(REPO_ROOT, 'docs', 'guides', 'satellites', 'index.md')

/** A link the sidebar can never lose; its absence means the parser drifted. */
const SENTINEL_LINK = '/start/introduction'
/** Sanity floor for extracted nav links (the real count is well above it). */
const MIN_LINKS = 50

/** Tracked markdown pages under docs/ (drafts stay green until `git add`). */
function trackedDocsPages(): string[] {
  return execSync('git ls-files -z docs', { cwd: REPO_ROOT })
    .toString('utf8')
    .split('\0')
    .filter((p) => p.endsWith('.md'))
}

/** All internal `link: '...'` targets from the sidebar + nav in config.ts. */
function navLinks(configSource: string): string[] {
  return [...configSource.matchAll(/link:\s*'([^']+)'/g)]
    .map((m) => m[1]!)
    .filter((link) => link.startsWith('/'))
}

/** The srcExclude patterns (pages deliberately kept out of the built site). */
function srcExcludePatterns(configSource: string): string[] {
  const block = configSource.match(/srcExclude:\s*\[([^\]]*)\]/)
  if (!block) return []
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

/** Minimal matcher for the two shapes used: exact 'X.md' and prefix 'dir/*.md'. */
function isExcluded(pageRelToDocs: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('/*.md')
      ? pageRelToDocs.startsWith(pattern.slice(0, -'*.md'.length)) && pageRelToDocs.endsWith('.md')
      : pageRelToDocs === pattern
  )
}

/** Resolve a nav link to its markdown file (VitePress cleanUrls semantics). */
function linkToPage(link: string): string {
  const clean = link.split('#')[0]!
  if (clean.endsWith('/')) return `docs${clean}index.md`
  const direct = `docs${clean}.md`
  return existsSync(join(REPO_ROOT, direct)) ? direct : `docs${clean}/index.md`
}

test.group('Docs integrity: site navigation', () => {
  test('every docs page is reachable from the sidebar or nav', ({ assert }) => {
    const config = readFileSync(CONFIG_PATH, 'utf8')
    const links = navLinks(config)
    const excludes = srcExcludePatterns(config)

    // Tripwires: a silently-drifted parser must fail here, not pass vacuously.
    assert.include(links, SENTINEL_LINK, 'parser drifted vs config.ts: sentinel link not found')
    assert.isAtLeast(links.length, MIN_LINKS, 'parser drifted vs config.ts: too few nav links')
    assert.isNotEmpty(excludes, 'parser drifted vs config.ts: srcExclude parsed empty')

    const reachable = new Set(links.map(linkToPage))
    const orphans = trackedDocsPages().filter((page) => {
      if (page === 'docs/index.md') return false // the site root, always served
      if (isExcluded(page.slice('docs/'.length), excludes)) return false
      return !reachable.has(page)
    })

    assert.deepEqual(
      orphans,
      [],
      [
        'Docs pages exist but are wired into no menu (they ship invisible):',
        ...orphans.map((p) => `  - ${p}`),
        '',
        'Add a sidebar entry in docs/.vitepress/config.ts, or, for internal',
        'material that should not be published, add it to srcExclude.',
      ].join('\n')
    )
  })

  test('every satellite guide is linked from the satellites overview page', ({ assert }) => {
    const body = readFileSync(OVERVIEW_PATH, 'utf8')
    const linked = new Set(
      [...body.matchAll(/\]\(\/guides\/satellites\/([^)#\s]+)\)/g)].map((m) => m[1])
    )
    assert.isNotEmpty(linked, 'parser drifted vs the overview page: no satellite links found')

    const missing = trackedDocsPages()
      .filter(
        (p) => p.startsWith('docs/guides/satellites/') && p !== 'docs/guides/satellites/index.md'
      )
      .map((p) => p.slice('docs/guides/satellites/'.length, -'.md'.length))
      .filter((guide) => !linked.has(guide))

    assert.deepEqual(
      missing,
      [],
      [
        'Satellite guides missing from the overview page (docs/guides/satellites/index.md):',
        ...missing.map((g) => `  - ${g}`),
        '',
        "Add each one to the satellites table or to the 'Also documented in this",
        "section' callout, whichever fits what the satellite is.",
      ].join('\n')
    )
  })
})
