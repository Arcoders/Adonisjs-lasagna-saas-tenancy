import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  HookRegistry,
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { createTestTenant, destroyTestTenant } from '../../../integration/helpers/tenant.js'

/**
 * I2 — Fail-closed destroy: a throwing satellite cleanup hook leaves no
 * half-destroyed state.
 *
 * `before('destroy')` runs BEFORE driver.destroy (DROP SCHEMA CASCADE), and
 * before-hooks re-throw (hook_registry.ts:125). So when a satellite's cleanup
 * hook throws, the destroy aborts and driver.destroy never runs: the schema and
 * its rows survive intact. There is no partial state to recover from. A sibling
 * tenant with a healthy hook then destroys cleanly, proving the abort was scoped
 * to the failing tenant and did not wedge the destroy path. The unit-level
 * guarantee this rests on is pinned by hook_registry.spec.ts (U1 anchor).
 */
async function findTenantModel(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

async function schemaExists(name: string): Promise<boolean> {
  const result = await db.rawQuery(
    'SELECT 1 FROM information_schema.schemata WHERE schema_name = ?',
    [name]
  )
  return Array.isArray(result.rows) ? result.rows.length > 0 : (result as any).length > 0
}

async function runDestroySequence(
  hooks: HookRegistry,
  driver: SchemaPgDriver,
  tenant: TenantModelContract
): Promise<void> {
  await hooks.run('before', 'destroy', { tenant })
  await driver.destroy(tenant)
  await hooks.run('after', 'destroy', { tenant })
}

test.group('Satellite destroy hook fail-closed (I2)', (group) => {
  let driver: SchemaPgDriver
  const created: string[] = []

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`I2 requires the schema-pg driver (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver
  })

  group.each.teardown(async () => {
    while (created.length) {
      const id = created.pop()!
      await db.connection('backoffice').from('tenant_feature_flags').where('tenant_id', id).delete()
      await driver.destroy({ id } as any).catch(() => {})
      await destroyTestTenant(id).catch(() => {})
    }
  })

  test('a throwing before(destroy) hook aborts the destroy, leaving schema and rows intact', async ({
    assert,
  }) => {
    const row = await createTestTenant({ status: 'active' })
    created.push(row.id)
    const tenant = await findTenantModel(row.id)

    await driver.provision(tenant)
    await db.connection(`tenant_${row.id}`).rawQuery(`
      CREATE TABLE app_data (id serial PRIMARY KEY, label text NOT NULL)
    `)
    await db.connection(`tenant_${row.id}`).table('app_data').insert({ label: 'must-survive' })
    await db
      .connection('backoffice')
      .table('tenant_feature_flags')
      .insert({ tenant_id: row.id, flag: 'beta', enabled: true })

    const failing = new HookRegistry()
    failing.before('destroy', () => {
      throw new Error('satellite cleanup failed')
    })

    await assert.rejects(
      () => runDestroySequence(failing, driver, tenant),
      'satellite cleanup failed'
    )

    // driver.destroy never ran: no half-destroyed state.
    assert.isTrue(
      await schemaExists(`tenant_${row.id}`),
      'a failed before(destroy) hook must NOT drop the schema'
    )
    const rows = await db.connection(`tenant_${row.id}`).from('app_data').count('* as c')
    assert.equal(Number(rows[0].c), 1, 'per-tenant rows must be intact after an aborted destroy')
    const flags = await db
      .connection('backoffice')
      .from('tenant_feature_flags')
      .where('tenant_id', row.id)
      .count('* as c')
    assert.equal(Number(flags[0].c), 1, 'backoffice rows must be intact after an aborted destroy')
  })

  test('a sibling with a healthy hook still destroys cleanly', async ({ assert }) => {
    const row = await createTestTenant({ status: 'active' })
    created.push(row.id)
    const tenant = await findTenantModel(row.id)
    await driver.provision(tenant)
    await db
      .connection('backoffice')
      .table('tenant_feature_flags')
      .insert({ tenant_id: row.id, flag: 'beta', enabled: true })

    const healthy = new HookRegistry()
    let hookRan = false
    healthy.before('destroy', async (ctx) => {
      hookRan = true
      await db
        .connection('backoffice')
        .from('tenant_feature_flags')
        .where('tenant_id', ctx.tenant.id)
        .delete()
    })

    await assert.doesNotReject(() => runDestroySequence(healthy, driver, tenant))
    assert.isTrue(hookRan, 'the healthy cleanup hook must have run')
    assert.isFalse(
      await schemaExists(`tenant_${row.id}`),
      'a healthy destroy must drop the schema as usual'
    )
    const flags = await db
      .connection('backoffice')
      .from('tenant_feature_flags')
      .where('tenant_id', row.id)
      .count('* as c')
    assert.equal(Number(flags[0].c), 0, 'the healthy hook must have cleaned up its backoffice rows')

    // Already torn down; drop from the cleanup list to avoid a redundant destroy.
    created.splice(created.indexOf(row.id), 1)
    await destroyTestTenant(row.id).catch(() => {})
  })
})
