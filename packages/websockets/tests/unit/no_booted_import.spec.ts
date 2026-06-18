import { test } from '@japa/runner'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `src/**` must load without a booted AdonisJS app, so its unit suite (and any
 * consumer importing the root entry before boot) stays hermetic. The forbidden
 * modules top-level-`await app.booted(...)` and throw outside an Ignitor; the
 * root barrel (`@adonisjs-lasagna/saas-tenancy`) pulls the logger in transitively.
 *
 * Those imports are fine in `providers/**`, which only runs inside the boot — so
 * this scan is scoped to `src/**`. A dynamic `await import(...)` is allowed (no
 * `from` clause, so the matcher below skips it).
 */
const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

const FORBIDDEN =
  /\bfrom\s+['"](@adonisjs\/core\/services\/logger|@adonisjs\/core\/services\/app|@adonisjs\/lucid\/services\/db|@adonisjs-lasagna\/saas-tenancy)['"]/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.ts')) yield full
  }
}

test.group('Architectural: src stays app.booted-safe', () => {
  test('no static import of an app.booted-touching module in src/**', ({ assert }) => {
    const violations: string[] = []
    for (const file of walk(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!isComment(line) && FORBIDDEN.test(line)) {
            violations.push(`${relative(SRC, file)}:${i + 1} — ${line.trim().slice(0, 100)}`)
          }
        })
    }

    assert.deepEqual(
      violations,
      [],
      `src/** must not statically import an app.booted-touching module (use a lazy ` +
        `await import(...), or move the import into providers/**):\n${violations.join('\n')}`
    )
  })

  test('the detector flags the root barrel but not a subpath/dynamic import', ({ assert }) => {
    assert.isTrue(FORBIDDEN.test(`import { tenancy } from '@adonisjs-lasagna/saas-tenancy'`))
    assert.isTrue(FORBIDDEN.test(`import logger from '@adonisjs/core/services/logger'`))
    assert.isFalse(
      FORBIDDEN.test(`import { isUuidV4 } from '@adonisjs-lasagna/saas-tenancy/internal'`)
    )
    assert.isFalse(FORBIDDEN.test(`const x = await import('@adonisjs/core/services/logger')`))
  })
})
