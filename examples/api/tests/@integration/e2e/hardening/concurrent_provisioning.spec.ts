import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import Tenant from '#app/models/backoffice/tenant'
import { dropAllTenants, installInline } from '../_helpers.js'

/**
 * HARDENING: concurrent provisioning is idempotent (no duplicate schema).
 *
 * The schema-pg driver provisions with `CREATE SCHEMA IF NOT EXISTS`
 * (packages/core/src/services/isolation/schema_pg_driver.ts), and the demo
 * Tenant.install() mirrors it. So two provisioning passes for the same tenant
 * id (a job retry racing a manual install, say) must converge on a single
 * schema with the tenant left `active`, and neither pass may throw.
 */
test.group('hardening — concurrent provisioning idempotency', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('two concurrent installs of the same tenant → one schema, status active, no error', async ({
    client,
    assert,
  }) => {
    const r = await client
      .post('/demo/tenants')
      .json({ name: 'Racey', email: 'racey@e2e.test', plan: 'pro', tier: 'premium' })
    r.assertStatus(202)
    const id = r.body().tenantId as string

    // Provision twice at once. Both must reach 'active' (the IF NOT EXISTS makes
    // the schema creation idempotent; the row updates converge on the same key).
    const [first, second] = await Promise.all([installInline(id), installInline(id)])
    assert.equal(first, 'active', 'first concurrent install must succeed')
    assert.equal(second, 'active', 'second concurrent install must succeed')

    const schema = await db
      .connection('public')
      .rawQuery(
        'SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = ?',
        [`tenant_${id}`]
      )
    assert.equal(schema.rows[0].n, 1, 'exactly one schema must exist — no duplicate')

    const tenant = await Tenant.findOrFail(id)
    assert.equal(tenant.status, 'active', 'the tenant must be left in the active state')
  }).timeout(30_000)
})
