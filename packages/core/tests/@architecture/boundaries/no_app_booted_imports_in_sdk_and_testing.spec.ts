import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * Anti-regression guard for two surfaces that MUST load without a booted app:
 *
 *  - `src/sdk/**`: the packaged-satellite toolkit runs inside a bare `configure`
 *    context (and in third-party satellites' own configure hooks), before any
 *    Ignitor. It must never statically import an app.booted-touching module.
 *  - `src/testing/**`: the `/testing` barrel must be importable in a hermetic
 *    unit test (see testing/barrel_hermetic.spec.ts). `factory.ts` already
 *    regressed once by top-level-importing `@adonisjs/lucid/services/db`.
 *
 * The forbidden modules top-level-`await app.booted(...)`, which throws outside
 * an Ignitor. A *dynamic* `import('...')` (deferred to call time) is fine: it
 * has no `from` clause, so the `from '<module>'` matcher below does not flag it.
 */

const ROOTS = [
  fileURLToPath(new URL('../../../src/sdk/', import.meta.url)),
  fileURLToPath(new URL('../../../src/testing/', import.meta.url)),
]

const FORBIDDEN =
  /\bfrom\s+['"](@adonisjs\/lucid\/services\/db|@adonisjs\/core\/services\/logger|@adonisjs\/core\/services\/app)['"]/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

test.group('Architectural: sdk + testing stay app.booted-safe', () => {
  test('no static import of an app.booted-touching module', ({ assert }) => {
    const violations: string[] = []

    for (const root of ROOTS) {
      if (!existsSync(root)) continue
      for (const file of walkTsFiles(root)) {
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (isComment(line)) return
          if (FORBIDDEN.test(line)) {
            violations.push(`${relative(root, file)}:${i + 1} — ${line.trim().slice(0, 100)}`)
          }
        })
      }
    }

    assert.deepEqual(
      violations,
      [],
      `A statically-imported app.booted-touching module in src/sdk or src/testing ` +
        `(it throws outside an Ignitor — use a lazy \`await import(...)\` at call time):\n` +
        `${violations.join('\n')}`
    )
  })

  test('the detector flags static imports but not dynamic ones (controls)', ({ assert }) => {
    for (const snippet of [
      `import db from '@adonisjs/lucid/services/db'`,
      `import logger from '@adonisjs/core/services/logger'`,
      `export { default } from '@adonisjs/core/services/app'`,
    ]) {
      assert.isTrue(FORBIDDEN.test(snippet), `should flag: ${snippet}`)
    }
    for (const snippet of [
      `const db = (await import('@adonisjs/lucid/services/db')).default`,
      `import { getConfig } from '../config.js'`,
      `import { readFile } from 'node:fs/promises'`,
    ]) {
      assert.isFalse(FORBIDDEN.test(snippet), `should NOT flag: ${snippet}`)
    }
  })
})
