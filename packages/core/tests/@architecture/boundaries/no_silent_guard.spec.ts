import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'
import { ISTHMUS_REGISTRY } from '../../../src/isthmus/registry.js'
import { NO_SILENT_GUARD_ALLOWLIST } from '../../../src/isthmus/no_silent_guard_allowlist.js'

/**
 * No silent guard: a fail-closed rejection (detected by the package's "Refusing
 * …" guard idiom adjacent to a `throw`) must either belong to a registered
 * Isthmus guard that emits, or carry a written allowlist reason. This scan is
 * the Audit-coverage Index's denominator (`scripts/check-isthmus.mjs` computes
 * the same sites from the same two single-source modules), so an unregistered
 * guard shows up BOTH here and in the CI gate until it is registered or
 * allowlisted-with-why.
 *
 * Detector shape: from each `throw new` line, look FORWARD up to 4 lines
 * (excluding comment lines) for the "refus…" message. Forward-only on purpose:
 * a comment ABOVE a throw ("refuse unless the caller overrides") describes
 * intent, not the thrown message, and must not flag ordinary API errors.
 */

const CORE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SRC_ROOT = join(CORE_ROOT, 'src')

const THROW_LINE = /\bthrow new /
const REFUSAL = /refus/i
const WINDOW = 4

const REGISTERED_FILES = new Set<string>(ISTHMUS_REGISTRY.map((e) => e.guardFile))
const ALLOWED_FILES = new Set(NO_SILENT_GUARD_ALLOWLIST.map((e) => e.path))

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** Line numbers (1-based) of fail-closed throw sites in a source text. */
export function refusalThrowSites(src: string): number[] {
  const lines = src.split('\n')
  const sites: number[] = []
  lines.forEach((line, i) => {
    if (isComment(line) || !THROW_LINE.test(line)) return
    const window = lines.slice(i, i + WINDOW + 1).filter((l) => !isComment(l))
    if (window.some((l) => REFUSAL.test(l))) sites.push(i + 1)
  })
  return sites
}

test.group('architectural — no silent guard', () => {
  test('every refusal throw site is registered-and-emitting or allowlisted', ({ assert }) => {
    const violations: string[] = []
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(CORE_ROOT, file).replace(/\\/g, '/')
      const src = readFileSync(file, 'utf8')
      const sites = refusalThrowSites(src)
      if (sites.length === 0) continue
      if (ALLOWED_FILES.has(rel)) continue
      if (REGISTERED_FILES.has(rel) && src.includes('emitIsthmusEvent(')) continue
      violations.push(`${rel}:${sites.join(',')}`)
    }
    assert.deepEqual(
      violations,
      [],
      [
        'Found fail-closed guard(s) that reject silently. Either register the guard in',
        'ISTHMUS_REGISTRY (src/isthmus/registry.ts) and emit before the throw, or add the',
        'file to NO_SILENT_GUARD_ALLOWLIST with a written reason.',
        '',
        'Violations:',
        ...violations.map((v) => '  - ' + v),
      ].join('\n')
    )
  })

  test('the allowlist is not stale (paths exist and still contain a refusal site)', ({
    assert,
  }) => {
    for (const { path } of NO_SILENT_GUARD_ALLOWLIST) {
      const full = join(CORE_ROOT, path)
      assert.isTrue(existsSync(full), `allowlisted path no longer exists: ${path}`)
      const sites = refusalThrowSites(readFileSync(full, 'utf8'))
      assert.isAbove(sites.length, 0, `allowlisted path has no refusal site left: ${path}`)
    }
  })

  test('every allowlist entry carries a written reason', ({ assert }) => {
    for (const entry of NO_SILENT_GUARD_ALLOWLIST) {
      assert.isAbove(
        entry.why.trim().length,
        20,
        `allowlist entry ${entry.path} needs a real reason, not a stub`
      )
    }
  })

  test('detector controls: flags refusal throws, ignores comments and plain errors', ({
    assert,
  }) => {
    const flagged = [
      `throw new Error('Refusing to build URL with unsafe host')`,
      [`throw new SafeFetchError(`, `  target,`, `  'safeFetch: refusing to fetch x'`, `)`].join(
        '\n'
      ),
    ]
    const clean = [
      `throw new Error('resolver.name must be a non-empty string')`,
      // A comment above the throw must not flag it (forward-only window).
      [`// Refuse unless the caller explicitly overrides.`, `throw new Error('duplicate')`].join(
        '\n'
      ),
      // A refusal in a comment BELOW the throw's statement is still a comment.
      [`throw new Error('duplicate')`, `// refuses to fall through`].join('\n'),
    ]
    for (const s of flagged) {
      assert.isAbove(refusalThrowSites(s).length, 0, `should flag:\n${s}`)
    }
    for (const s of clean) {
      assert.lengthOf(refusalThrowSites(s), 0, `should NOT flag:\n${s}`)
    }
  })
})
