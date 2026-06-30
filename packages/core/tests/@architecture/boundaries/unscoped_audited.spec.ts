import { test } from '@japa/runner'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * WS-6: the scope-bypass seam has exactly one door, and that door is audited.
 *
 *   1. `bypassStorage.run(` (the AsyncLocalStorage that flips off the tenant
 *      scope) appears in exactly ONE place across every package src: `unscoped`
 *      in models/scoping.ts. No module may open a bare bypass elsewhere.
 *   2. `unscoped` routes through `recordScopeBypass`, so a bypass is never
 *      invisible.
 *
 * Together these stop a future change from adding an unaudited escape hatch.
 */

const PACKAGES_DIR = fileURLToPath(new URL('../../../../', import.meta.url))
const SCOPING = fileURLToPath(new URL('../../../src/models/scoping.ts', import.meta.url))

const BYPASS_RUN = /bypassStorage\.run\s*\(/g

function srcRoots(): string[] {
  const roots: string[] = []
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, entry, 'src')
    if (existsSync(src) && statSync(src).isDirectory()) roots.push(src)
  }
  return roots
}

test.group('architectural — scope bypass has one audited door', () => {
  test('bypassStorage.run appears only in models/scoping.ts', ({ assert }) => {
    const sites: string[] = []
    for (const root of srcRoots()) {
      for (const file of walkTsFiles(root)) {
        const src = readFileSync(file, 'utf8')
        const matches = src.match(BYPASS_RUN)
        if (matches)
          sites.push(`${relative(PACKAGES_DIR, file).replace(/\\/g, '/')} (${matches.length})`)
      }
    }
    assert.deepEqual(
      sites,
      ['core/src/models/scoping.ts (1)'],
      `bypassStorage.run must appear exactly once, only in scoping.ts. Found: ${sites.join(', ')}`
    )
  })

  test('unscoped routes through recordScopeBypass', ({ assert }) => {
    const src = readFileSync(SCOPING, 'utf8')
    assert.match(src, /recordScopeBypass\s*\(/, 'unscoped() must emit a bypass audit event')
    // The emit must be gated so nested bypasses do not double-audit (re-entrancy).
    assert.match(src, /alreadyAudited/, 'unscoped() must guard against re-entrant double-auditing')
  })

  test('detector control: the matcher is not vacuously true', ({ assert }) => {
    assert.match('bypassStorage.run({ bypass: true }, fn)', BYPASS_RUN)
    assert.notMatch('otherStorage.run(fn)', /bypassStorage\.run\s*\(/)
  })
})
