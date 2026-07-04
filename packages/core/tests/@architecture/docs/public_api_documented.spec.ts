import { test } from '@japa/runner'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../../../../satellite-test-kit/src/repo_root.js'

/**
 * Docs-integrity guard #3 of 3: every published package in the monorepo has a
 * documentation landing page and is referred to by its npm name on the docs site.
 *
 * Scope is deliberately package-level, not symbol-level. Per-export coverage
 * (every type/function name mentioned) is too noisy to gate on; the precise
 * guards live in the sibling specs (`commands_documented`, `config_documented`).
 * What this catches is the structural drift: a new satellite shipping without a
 * landing page, or a package renamed without the docs following.
 */

const REPO_ROOT = repoRoot(import.meta.url)
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const DOCS_DIR = join(REPO_ROOT, 'docs')

/**
 * Landing page per package, relative to the repo root. The six satellites map to
 * `docs/guides/satellites/<dir>.md` by convention; the two non-satellite packages
 * (the template and the dev-only test kit) live on their guide pages. Core is
 * documented across the whole site, so it is mention-only (null).
 */
const LANDING_OVERRIDES: Record<string, string | null> = {
  'core': null,
  'satellite-template': 'docs/guides/cookbook/creating-a-satellite.md',
  'satellite-test-kit': 'docs/guides/testing.md',
  // Private dev-only tool (not a satellite); its learning page is the guide.
  'doc-coverage': 'docs/guides/documentation-coverage.md',
}

function packageDirs(): string[] {
  return readdirSync(PACKAGES_DIR).filter((e) => {
    try {
      return statSync(join(PACKAGES_DIR, e)).isDirectory()
    } catch {
      return false
    }
  })
}

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

test.group('Docs integrity: public API surface', () => {
  test('every package has a landing page and is named on the docs site', ({ assert }) => {
    const corpus = docsCorpus(DOCS_DIR)
    const problems: string[] = []

    for (const dir of packageDirs()) {
      const pkgJsonPath = join(PACKAGES_DIR, dir, 'package.json')
      if (!existsSync(pkgJsonPath)) continue
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
      const name: string = pkg.name
      if (!name) continue
      // Private, in-build packages are not published; they enter the docs when
      // they graduate to public (mirrors the stability + publish-coverage guards,
      // which also key off `private`). The spec's scope is published packages.
      if (pkg.private === true) continue

      // 1) The npm name must appear somewhere on the site.
      if (!corpus.includes(name)) {
        problems.push(`${dir}: package name "${name}" is never mentioned in docs/`)
      }

      // 2) A dedicated landing page must exist (except core, mention-only).
      const landing =
        dir in LANDING_OVERRIDES ? LANDING_OVERRIDES[dir] : `docs/guides/satellites/${dir}.md`
      if (landing && !existsSync(join(REPO_ROOT, landing))) {
        problems.push(`${dir}: expected landing page ${landing} does not exist`)
      }
    }

    assert.deepEqual(
      problems,
      [],
      [
        'Documentation coverage problems for published packages:',
        ...problems.map((p) => `  - ${p}`),
        '',
        'Add the landing page (or update LANDING_OVERRIDES in this spec if the page',
        'intentionally lives elsewhere).',
      ].join('\n')
    )
  })
})
