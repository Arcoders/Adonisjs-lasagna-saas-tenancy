import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant, updateTenantStatus } from '../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * S2-1: drives a tenant through every lifecycle stage the package
 * exposes — provision → seed data → suspend → destroy → recreate
 * with the same UUID — and asserts at each transition that the
 * observable state matches the documented contract.
 *
 * The recreate-with-same-UUID phase is the load-bearing one: it
 * proves that destroy() really tears down the schema (and connection
 * pool) so a subsequent provision() with the same id starts from
 * empty, with no leaked rows or stale connection state.
 */
async function findTenantModel(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../fixtures/app/models/tenant.js')).default
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

async function tableExists(schema: string, table: string): Promise<boolean> {
  const result = await db.rawQuery(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
    [schema, table]
  )
  return Array.isArray(result.rows) ? result.rows.length > 0 : (result as any).length > 0
}

test.group('Tenant lifecycle E2E (provision → suspend → destroy → recreate)', (group) => {
  let driver: SchemaPgDriver

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`Tenant lifecycle tests require schema-pg driver (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver
  })

  test('provision creates schema, seed survives status transitions, destroy wipes everything', async ({
    assert,
  }) => {
    const tenantRow = await createTestTenant({ status: 'provisioning' })
    const tenant = await findTenantModel(tenantRow.id)
    const schema = `tenant_${tenantRow.id}`

    // ----- 1. PROVISION -----
    await driver.provision(tenant)
    assert.isTrue(await schemaExists(schema), 'provision must create the tenant schema')
    assert.isTrue(
      db.manager.has(`tenant_${tenantRow.id}`),
      'provision must register the per-tenant connection'
    )

    // ----- 2. SEED DATA into the tenant schema -----
    await db.connection(`tenant_${tenantRow.id}`).rawQuery(`
      CREATE TABLE app_data (
        id    serial PRIMARY KEY,
        label text NOT NULL
      )
    `)
    await db
      .connection(`tenant_${tenantRow.id}`)
      .table('app_data')
      .insert([{ label: 'row-a' }, { label: 'row-b' }])
    assert.isTrue(await tableExists(schema, 'app_data'))

    // ----- 3. ACTIVATE -----
    await updateTenantStatus(tenantRow.id, 'active')

    // ----- 4. SUSPEND -----
    await updateTenantStatus(tenantRow.id, 'suspended')
    // Suspending is a backoffice flag — it does NOT touch the schema.
    // The seeded rows must still be there for the subsequent unsuspend.
    const seededRows = await db
      .connection(`tenant_${tenantRow.id}`)
      .from('app_data')
      .select('label')
      .orderBy('id')
    assert.deepEqual(
      seededRows.map((r) => r.label),
      ['row-a', 'row-b'],
      'suspend must not destroy data'
    )

    // ----- 5. UNSUSPEND -----
    await updateTenantStatus(tenantRow.id, 'active')
    const stillThere = await db
      .connection(`tenant_${tenantRow.id}`)
      .from('app_data')
      .count('* as c')
    assert.equal(Number(stillThere[0].c), 2)

    // ----- 6. DESTROY -----
    await driver.destroy(tenant)
    assert.isFalse(await schemaExists(schema), 'destroy must drop the schema')
    assert.isFalse(
      db.manager.has(`tenant_${tenantRow.id}`),
      'destroy must release the per-tenant connection from the manager'
    )

    await destroyTestTenant(tenantRow.id)
  })

  test('recreate with the same UUID starts from empty (no leaked rows or stale pool)', async ({
    assert,
  }) => {
    // Reuse a single id across two full provision/destroy cycles. The
    // first cycle seeds a sentinel row; the second cycle must see an
    // empty schema (the schema itself is recreated, the connection
    // pool is re-opened against the new schema).
    const reusedId = randomUUID()
    const schema = `tenant_${reusedId}`

    async function insertWithId(id: string, name: string): Promise<void> {
      await db
        .connection('backoffice')
        .table('tenants')
        .insert({
          id,
          name,
          email: `${name}-${id.slice(0, 8)}@fixture.test`,
          status: 'provisioning',
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
          custom_domain: null,
        })
    }

    // --- Cycle 1: provision, seed, destroy ---
    await insertWithId(reusedId, 'cycle-one')
    let tenant = await findTenantModel(reusedId)

    await driver.provision(tenant)
    await db.connection(`tenant_${reusedId}`).rawQuery(`
      CREATE TABLE leak_canary (
        id     serial PRIMARY KEY,
        marker text NOT NULL
      )
    `)
    await db
      .connection(`tenant_${reusedId}`)
      .table('leak_canary')
      .insert({ marker: 'belongs-to-cycle-one' })
    await driver.destroy(tenant)
    await destroyTestTenant(reusedId)
    assert.isFalse(await schemaExists(schema), 'destroy must drop schema between cycles')

    // --- Cycle 2: recreate with the same UUID ---
    await insertWithId(reusedId, 'cycle-two')
    tenant = await findTenantModel(reusedId)

    await driver.provision(tenant)
    assert.isTrue(await schemaExists(schema), 'cycle 2 provision must recreate the schema')
    assert.isFalse(
      await tableExists(schema, 'leak_canary'),
      "cycle 2 must NOT inherit cycle 1's table — schema must be empty"
    )

    // Cleanup.
    await driver.destroy(tenant)
    await destroyTestTenant(reusedId)
  })

  test('destroy is idempotent — calling twice does not throw', async ({ assert }) => {
    const tenantRow = await createTestTenant({ status: 'provisioning' })
    const tenant = await findTenantModel(tenantRow.id)
    await driver.provision(tenant)

    await driver.destroy(tenant)
    await assert.doesNotReject(
      () => driver.destroy(tenant),
      'a second destroy on a tenant without a schema must be a no-op, not a throw'
    )

    await destroyTestTenant(tenantRow.id)
  })

  test('provision after a previous destroy in the same process resets the connection pool', async ({
    assert,
  }) => {
    // Regression guard for a real-world bug: if destroy() leaves the
    // connection pool registered, a follow-up provision() reuses an
    // OID-cached session that points at a non-existent schema, and
    // queries silently see "no such table". A fresh manager state is
    // the only way to be safe.
    const tenantRow = await createTestTenant({ status: 'provisioning' })
    const tenant = await findTenantModel(tenantRow.id)
    const connName = `tenant_${tenantRow.id}`

    await driver.provision(tenant)
    await db.connection(connName).rawQuery(`CREATE TABLE x (id serial PRIMARY KEY)`)
    await db.connection(connName).table('x').insert({})

    await driver.destroy(tenant)
    assert.isFalse(db.manager.has(connName), 'destroy must release the manager entry')

    await driver.provision(tenant)
    // Issue a query through the freshly-rebuilt connection. If the
    // pool was stale this would either throw "relation does not exist"
    // (different OID) or return ghost rows from the previous schema.
    await assert.doesNotReject(() =>
      db.connection(connName).rawQuery(`CREATE TABLE x (id serial PRIMARY KEY)`)
    )
    const empty = await db.connection(connName).from('x').count('* as c')
    assert.equal(Number(empty[0].c), 0, 'recreated schema must be empty, not show stale rows')

    await driver.destroy(tenant)
    await destroyTestTenant(tenantRow.id)
  })
})
