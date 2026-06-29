import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  type SchemaPgDriver,
  IsolationDriverRegistry,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../../integration/helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

async function findTenant(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`fixture tenant ${id} not found after creation`)
  return t as unknown as TenantModelContract
}

async function schemaExists(name: string): Promise<boolean> {
  const result = await db.rawQuery(
    'SELECT 1 FROM information_schema.schemata WHERE schema_name = ?',
    [name]
  )
  return Array.isArray(result.rows) ? result.rows.length > 0 : (result as any).length > 0
}

test.group('SchemaPgDriver (integration)', (group) => {
  let driver: SchemaPgDriver
  const created: string[] = []

  group.setup(async () => {
    // Drivers are activated in the provider; we resolve and assert the
    // active driver is schema-pg before exercising it.
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(
        `These tests require config.isolation.driver = 'schema-pg' (got '${active.name}')`
      )
    }
    driver = active as SchemaPgDriver
  })

  group.each.teardown(async () => {
    while (created.length) {
      const id = created.pop()!
      const schema = `tenant_${id}`
      await db.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
      await driver.disconnect({ id } as any).catch(() => {})
      await destroyTestTenant(id).catch(() => {})
    }
  })

  test('connectionName and schemaName mirror the configured prefixes', async ({ assert }) => {
    const t = await createTestTenant()
    created.push(t.id)
    assert.equal(driver.connectionName(t.id), `tenant_${t.id}`)
    assert.equal(driver.schemaName(t.id), `tenant_${t.id}`)
  })

  test('provision creates the schema and registers the connection', async ({ assert }) => {
    const t = await createTestTenant({ status: 'provisioning' })
    created.push(t.id)
    const tenant = await findTenant(t.id)

    await driver.provision(tenant)

    assert.isTrue(await schemaExists(`tenant_${t.id}`), 'schema should exist after provision')
    assert.isTrue(db.manager.has(`tenant_${t.id}`), 'connection should be registered in db.manager')
  })

  test('provision is idempotent — calling twice does not throw', async ({ assert }) => {
    const t = await createTestTenant({ status: 'provisioning' })
    created.push(t.id)
    const tenant = await findTenant(t.id)

    await driver.provision(tenant)
    await assert.doesNotReject(() => driver.provision(tenant))
  })

  test('connect returns a query client whose searchPath targets the tenant schema', async ({
    assert,
  }) => {
    const t = await createTestTenant({ status: 'provisioning' })
    created.push(t.id)
    const tenant = await findTenant(t.id)
    await driver.provision(tenant)

    const client = await driver.connect(tenant)
    const result = await client.rawQuery(`SHOW search_path`)
    const rows = Array.isArray(result.rows) ? result.rows : (result as any).rows
    assert.match(JSON.stringify(rows), new RegExp(`tenant_${t.id}`))
  })

  test('destroy drops the schema and unregisters the connection', async ({ assert }) => {
    const t = await createTestTenant({ status: 'provisioning' })
    created.push(t.id)
    const tenant = await findTenant(t.id)
    await driver.provision(tenant)
    assert.isTrue(await schemaExists(`tenant_${t.id}`))

    await driver.destroy(tenant)

    assert.isFalse(await schemaExists(`tenant_${t.id}`), 'schema should be dropped after destroy')
    assert.isFalse(
      db.manager.has(`tenant_${t.id}`),
      'connection should be unregistered after destroy'
    )
  })

  test('destroy with keepData preserves the schema but closes the connection', async ({
    assert,
  }) => {
    const t = await createTestTenant({ status: 'provisioning' })
    created.push(t.id)
    const tenant = await findTenant(t.id)
    await driver.provision(tenant)

    await driver.destroy(tenant, { keepData: true })

    assert.isTrue(await schemaExists(`tenant_${t.id}`), 'schema should be preserved with keepData')
    assert.isFalse(
      db.manager.has(`tenant_${t.id}`),
      'connection should be unregistered even with keepData'
    )
  })

  test('reset drops and recreates the schema', async ({ assert }) => {
    const t = await createTestTenant({ status: 'provisioning' })
    created.push(t.id)
    const tenant = await findTenant(t.id)
    await driver.provision(tenant)

    // Plant a sentinel table; reset must wipe it.
    const client = await driver.connect(tenant)
    await client.rawQuery(`CREATE TABLE sentinel (n int)`)
    await client.rawQuery(`INSERT INTO sentinel VALUES (42)`)

    await driver.reset(tenant)
    const fresh = await driver.connect(tenant)

    const tables = await fresh.rawQuery(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = ? AND table_name = 'sentinel'`,
      [`tenant_${t.id}`]
    )
    const found = Array.isArray(tables.rows) ? tables.rows.length : (tables as any).length
    assert.equal(found, 0, 'sentinel table must be gone after reset')
    assert.isTrue(await schemaExists(`tenant_${t.id}`), 'schema must exist after reset')
  })

  test('disconnect closes the connection without dropping data', async ({ assert }) => {
    const t = await createTestTenant({ status: 'provisioning' })
    created.push(t.id)
    const tenant = await findTenant(t.id)
    await driver.provision(tenant)
    assert.isTrue(db.manager.has(`tenant_${t.id}`))

    await driver.disconnect(tenant)

    assert.isFalse(db.manager.has(`tenant_${t.id}`))
    assert.isTrue(await schemaExists(`tenant_${t.id}`), 'schema must NOT be dropped')
  })
})
