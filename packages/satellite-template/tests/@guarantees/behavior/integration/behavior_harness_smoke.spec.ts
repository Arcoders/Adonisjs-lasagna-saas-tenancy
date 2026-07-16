import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

/**
 * Smoke canary for the shared integration harness, run from a fresh satellite.
 * It exercises the whole path a real consumer depends on: the Ignitor boot, the
 * `ensureBackofficeSchema` DDL, the `/testing` helpers, and the exit-code
 * recompute (the run exiting 0 at all proves the recompute). One trivial spec is
 * enough; depth lives in the satellites' own suites.
 */
test.group('satellite-test-kit harness smoke', () => {
  test('createTestTenant writes to backoffice.tenants and destroyTestTenant removes it', async ({
    assert,
  }) => {
    const tenant = await createTestTenant()

    const row = await db
      .connection('backoffice')
      .query()
      .from('tenants')
      .where('id', tenant.id)
      .first()
    assert.isNotNull(row)
    assert.equal(row.id, tenant.id)

    await destroyTestTenant(tenant.id)

    const gone = await db
      .connection('backoffice')
      .query()
      .from('tenants')
      .where('id', tenant.id)
      .first()
    assert.isNull(gone)
  })
})
