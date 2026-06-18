import { test } from '@japa/runner'

/**
 * Regression guard for the `/testing` barrel's hermeticity. The barrel must load
 * in a bare unit test (no Ignitor / no booted app) so satellite authors can
 * import the test helpers without standing up an application. This broke once:
 * `factory.ts` did a top-level `import db from '@adonisjs/lucid/services/db'`,
 * whose `await app.booted(...)` throws outside an Ignitor — making the whole
 * barrel (and anything re-exported from it) unimportable. It is now a lazy
 * import; this test fails the moment a top-level app.booted-touching import
 * sneaks back in.
 */
test.group('testing barrel hermeticity', () => {
  test('importing the /testing barrel does not require a booted app', async ({ assert }) => {
    const mod = await import('../../../src/testing/index.js')
    // A representative export is present, proving the module graph evaluated.
    assert.isFunction(mod.buildTestTenant)
    assert.isFunction(mod.createTestTenant)
  })
})
