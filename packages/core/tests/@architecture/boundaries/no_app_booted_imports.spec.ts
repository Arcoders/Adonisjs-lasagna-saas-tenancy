import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * Anti-regression guard for the surfaces that MUST load without a booted app:
 *
 *  - `src/sdk/**`: the packaged-satellite toolkit runs inside a bare `configure`
 *    context (and in third-party satellites' own configure hooks), before any
 *    Ignitor. It must never statically import an app.booted-touching module.
 *  - `src/testing/**`: the `/testing` barrel must be importable in a hermetic
 *    unit test (see testing/barrel_hermetic.spec.ts). `factory.ts` already
 *    regressed once by top-level-importing `@adonisjs/lucid/services/db`.
 *  - `src/providers/**`: the provider is decomposed into per-subsystem installer
 *    modules the provider statically imports. A single static import of a
 *    booted-touching module in ANY installer would make the provider unloadable
 *    outside an Ignitor and break the integration specs that construct it
 *    (membership_gate_boot_warning, resolution_cache_lifecycle_wiring,
 *    resolver_baseline_guard). The provider and its helpers reach logger/db only
 *    through lazy `await import()`; this pins that for the whole directory.
 *
 * The forbidden modules top-level-`await app.booted(...)`, which throws outside
 * an Ignitor. A *dynamic* `import('...')` (deferred to call time) is fine: it
 * has no `from` clause, so the `from '<module>'` matcher below does not flag it.
 * (Note the Lucid `Database` CLASS at `@adonisjs/lucid/database` is a different
 * module from the `@adonisjs/lucid/services/db` singleton and is NOT forbidden.)
 */

const ROOTS = [
  fileURLToPath(new URL('../../../src/sdk/', import.meta.url)),
  fileURLToPath(new URL('../../../src/testing/', import.meta.url)),
  fileURLToPath(new URL('../../../src/providers/', import.meta.url)),
]

const FORBIDDEN =
  /\bfrom\s+['"](@adonisjs\/lucid\/services\/db|@adonisjs\/core\/services\/logger|@adonisjs\/core\/services\/app)['"]/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

test.group('Architectural: sdk + testing + providers stay app.booted-safe', () => {
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
      `A statically-imported app.booted-touching module in src/sdk, src/testing, or ` +
        `src/providers (it throws outside an Ignitor — use a lazy \`await import(...)\` ` +
        `at call time):\n${violations.join('\n')}`
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
      `import { Database } from '@adonisjs/lucid/database'`,
      `import { readFile } from 'node:fs/promises'`,
    ]) {
      assert.isFalse(FORBIDDEN.test(snippet), `should NOT flag: ${snippet}`)
    }
  })
})
