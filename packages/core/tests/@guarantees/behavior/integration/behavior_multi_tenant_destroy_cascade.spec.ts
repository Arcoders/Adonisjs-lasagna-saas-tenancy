import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  HookRegistry,
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'

/**
 * I1 — Multi-tenant destroy cascade (no cross-tenant collateral).
 *
 * Three tenants are provisioned and each gets rows in two backoffice satellite
 * tables plus a row in its own per-tenant schema. A satellite-style
 * `before('destroy')` cleanup hook (the pattern from the satellite template's
 * example provider) deletes ONLY the destroyed tenant's backoffice rows, scoped
 * by the tenant id the hook receives.
 *
 * Destroying tenant #2 runs the documented destroy sequence
 * (commands/destroy_tenant.ts:46-62): before('destroy') hook -> driver.destroy
 * (DROP SCHEMA CASCADE) -> after('destroy'). The headline assertion is that #1
 * and #3 are completely untouched (their backoffice rows and per-tenant schemas
 * survive), so a destroy never leaks into a sibling tenant.
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

async function backofficeRowCount(table: string, tenantId: string): Promise<number> {
  const rows = await db
    .connection('backoffice')
    .from(table)
    .where('tenant_id', tenantId)
    .count('* as c')
  return Number(rows[0].c)
}

/** Mirrors the destroy ordering in commands/destroy_tenant.ts (the bits that bear on cascade). */
async function runDestroySequence(
  hooks: HookRegistry,
  driver: SchemaPgDriver,
  tenant: TenantModelContract
): Promise<void> {
  await hooks.run('before', 'destroy', { tenant })
  await driver.destroy(tenant)
  await hooks.run('after', 'destroy', { tenant })
}

test.group('Satellite multi-tenant destroy cascade (I1)', (group) => {
  let driver: SchemaPgDriver
  const created: string[] = []

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`I1 requires the schema-pg driver (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver
  })

  group.each.teardown(async () => {
    while (created.length) {
      const id = created.pop()!
      await db.connection('backoffice').from('tenant_feature_flags').where('tenant_id', id).delete()
      await db.connection('backoffice').from('tenant_brandings').where('tenant_id', id).delete()
      await driver.destroy({ id } as any).catch(() => {})
      await destroyTestTenant(id).catch(() => {})
    }
  })

  test('destroying one tenant cascades its data only, siblings stay fully intact', async ({
    assert,
  }) => {
    const models: TenantModelContract[] = []
    for (let i = 0; i < 3; i++) {
      const row = await createTestTenant({ status: 'active' })
      created.push(row.id)
      const tenant = await findTenantModel(row.id)
      models.push(tenant)

      await driver.provision(tenant)
      // A row in the tenant's own schema (searchPath = tenant_<uuid>).
      await db.connection(`tenant_${row.id}`).rawQuery(`
        CREATE TABLE app_data (id serial PRIMARY KEY, label text NOT NULL)
      `)
      await db
        .connection(`tenant_${row.id}`)
        .table('app_data')
        .insert({ label: `owned-by-${i}` })

      // Rows in two backoffice satellite tables, keyed by tenant_id.
      await db
        .connection('backoffice')
        .table('tenant_feature_flags')
        .insert({ tenant_id: row.id, flag: 'beta', enabled: true })
      await db
        .connection('backoffice')
        .table('tenant_brandings')
        .insert({ tenant_id: row.id, from_name: `Tenant ${i}` })
    }

    // Satellite cleanup hook: deletes ONLY the destroyed tenant's backoffice rows.
    const hooks = new HookRegistry()
    hooks.before('destroy', async (ctx) => {
      await db
        .connection('backoffice')
        .from('tenant_feature_flags')
        .where('tenant_id', ctx.tenant.id)
        .delete()
      await db
        .connection('backoffice')
        .from('tenant_brandings')
        .where('tenant_id', ctx.tenant.id)
        .delete()
    })

    // Exactly three tenants were pushed in the loop above.
    const [first, second, third] = models as [
      TenantModelContract,
      TenantModelContract,
      TenantModelContract,
    ]

    await runDestroySequence(hooks, driver, second)

    // Headline: no cross-tenant collateral. #1 and #3 keep every row + schema.
    for (const survivor of [first, third]) {
      assert.isTrue(
        await schemaExists(`tenant_${survivor.id}`),
        `sibling tenant ${survivor.id} schema must survive a sibling's destroy`
      )
      assert.equal(
        await backofficeRowCount('tenant_feature_flags', survivor.id),
        1,
        'sibling feature-flag row must be untouched'
      )
      assert.equal(
        await backofficeRowCount('tenant_brandings', survivor.id),
        1,
        'sibling branding row must be untouched'
      )
      const ownData = await db.connection(`tenant_${survivor.id}`).from('app_data').count('* as c')
      assert.equal(Number(ownData[0].c), 1, 'sibling per-tenant data must be untouched')
    }

    // The destroyed tenant: hook fired (backoffice rows gone) AND schema CASCADE-dropped.
    assert.equal(await backofficeRowCount('tenant_feature_flags', second.id), 0)
    assert.equal(await backofficeRowCount('tenant_brandings', second.id), 0)
    assert.isFalse(
      await schemaExists(`tenant_${second.id}`),
      'destroyed tenant schema must be dropped (CASCADE)'
    )
  })
})
