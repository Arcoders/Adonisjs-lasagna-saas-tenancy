import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import Tenant from '#app/models/backoffice/tenant'
import {
  ADMIN_HEADERS,
  createInstalledTenant,
  dropAllTenants,
  installInline,
  runAce,
} from '../_helpers.js'

/**
 * HARDENING — tenant provisioning & lifecycle.
 *
 * Covers the create → provision → soft-delete (with retention) → purge and the
 * restore paths, asserting the physical schema (`tenant_<uuid>`) appears and
 * disappears at the right moments and that a restored tenant keeps its data.
 * Clone / backup / import are exercised by the existing
 * tests/e2e/backups_real.spec.ts and commands_lifecycle.spec.ts and are mapped
 * in COVERAGE_MATRIX.md rather than duplicated here.
 */
test.group('hardening — provisioning & lifecycle', (group) => {
  const schemaExists = async (id: string) => {
    const r = await db
      .connection('public')
      .rawQuery('SELECT 1 FROM information_schema.schemata WHERE schema_name = ?', [`tenant_${id}`])
    return r.rows.length > 0
  }

  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('creating a tenant provisions a dedicated tenant_<uuid> schema', async ({
    client,
    assert,
  }) => {
    const r = await client
      .post('/demo/tenants')
      .json({ name: 'Provision', email: 'provision@e2e.test', plan: 'pro', tier: 'premium' })
    r.assertStatus(202)
    const id = r.body().tenantId as string

    assert.isFalse(await schemaExists(id), 'schema must not exist before install completes')
    const status = await installInline(id)
    assert.equal(status, 'active')
    assert.isTrue(await schemaExists(id), 'schema tenant_<uuid> must exist after provisioning')
  })

  test('soft-delete keeps the schema during retention; purge-expired drops it', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { plan: 'free' })

    const del = await client.delete(`/demo/tenants/${id}?keepSchema=true`)
    del.assertStatus(200)
    assert.isTrue(del.body().softDeleted)

    const tenant = await Tenant.query().where('id', id).firstOrFail()
    assert.isNotNull(tenant.deletedAt, 'deleted_at must be set on soft-delete')
    assert.isTrue(await schemaExists(id), 'schema must survive a soft-delete (retention window)')

    // Retention 0 + force purges everything already past its (zero-length) window.
    const code = await runAce('tenant:purge-expired', ['--retention-days', '0', '--force'])
    assert.equal(code, 0)
    assert.isFalse(await schemaExists(id), 'schema must be dropped once retention has elapsed')
  })

  test('restore brings back a soft-deleted tenant with its data intact', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { plan: 'free' })

    // Write a row we can look for after the restore round-trip.
    const note = await client
      .post('/demo/notes')
      .header('x-tenant-id', id)
      .json({ title: 'survives-restore' })
    note.assertStatus(201)

    // Soft-delete but keep the schema so restore has data to come back to.
    const del = await client.delete(`/demo/tenants/${id}?keepSchema=true`)
    del.assertStatus(200)

    const restore = await client.post(`/admin/tenants/${id}/restore`).headers(ADMIN_HEADERS)
    restore.assertStatus(200)

    const tenant = await Tenant.findOrFail(id)
    assert.isNull(tenant.deletedAt, 'restore must clear deleted_at')
    assert.equal(tenant.status, 'active', 'restored tenant must be active again')

    // Direct-DB check: the row written before deletion is still there.
    const rows = await tenant.getConnection().rawQuery('SELECT title FROM notes')
    const titles = rows.rows.map((r: { title: string }) => r.title)
    assert.include(titles, 'survives-restore', 'restored schema must still hold its rows')
  })

  test('lifecycle events are recorded in the audit log', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { plan: 'pro' })
    const audit = await client.get('/demo/audit').header('x-tenant-id', id)
    audit.assertStatus(200)
    const actions = audit.body().rows.map((row: { action: string }) => row.action)
    assert.include(actions, 'tenant.created', 'the create lifecycle event must be audited')
  })
})
