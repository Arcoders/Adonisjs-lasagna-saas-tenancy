import { test } from '@japa/runner'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-7 / admin-export-throw-shim.
 *
 * The admin REST API moved to `@adonisjs-lasagna/admin`, but core still shipped a
 * `./admin` subpath export pointing at a `src/admin/index.ts` that throws on
 * import. Pre-publish there is no published version to keep back-compat with, so
 * the dead throw-shim and its export/typesVersions entries are removed outright
 * — importing the wrong path now fails with a clean module-not-found.
 *
 * RED (pre-fix): the export, the typesVersions entry, and the shim file existed.
 */
const PKG = fileURLToPath(new URL('../../package.json', import.meta.url))
const SHIM = fileURLToPath(new URL('../../src/admin/index.ts', import.meta.url))

test.group('architectural — no /admin throw shim', () => {
  test('the ./admin export, its typesVersions entry, and the shim file are gone', ({ assert }) => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
    assert.isUndefined(pkg.exports['./admin'], 'package.json must not declare the ./admin export')
    assert.isUndefined(pkg.typesVersions?.['*']?.admin, 'typesVersions must not declare admin')
    assert.isFalse(existsSync(SHIM), 'src/admin/index.ts shim must be deleted')
  })

  test('detector control: the asserts read real package fields', ({ assert }) => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
    // A still-shipped export proves the file/shape is parsed, not vacuously empty.
    assert.isDefined(pkg.exports['./services'])
    assert.isDefined(pkg.typesVersions['*'].services)
  })
})
