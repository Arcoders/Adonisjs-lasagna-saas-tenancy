import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Regression guard for the connection-eviction bug. The previous LRU evicted the
 * oldest connection purely by last-`connect()` time, with no notion of
 * "currently serving a request". Under more than `maxTenantConnections`
 * concurrent distinct tenants it could `release()` a pool that was mid-query,
 * severing it and dropping writes. That was the "~16/20 rows land per schema"
 * symptom seen in `cross_tenant_e2e`.
 *
 * With the in-use grace window, a connection touched within
 * `evictionGracePeriodMs` is never evicted: the pool is allowed to exceed the
 * cap for the duration of the burst instead of killing an active connection.
 * This test provisions more tenants than the cap, fires concurrent writes, and
 * asserts zero loss and zero cross-contamination.
 */
const CAP = 3
const TENANT_COUNT = 8
const WRITES_PER_TENANT = 12

async function findTenantModel(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

test.group('SchemaPgDriver — connection eviction safety under load (H1)', (group) => {
  let driver: SchemaPgDriver
  let original: MultitenancyConfig

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(`eviction-safety test requires schema-pg driver (got '${active.name}')`)
    }
    driver = active as SchemaPgDriver

    // Squeeze the cap below the tenant count so eviction pressure is real, and
    // keep a generous grace window so in-flight connections stay protected.
    original = getConfig()
    setConfig({
      ...original,
      isolation: {
        ...(original.isolation ?? { driver: 'schema-pg' }),
        driver: 'schema-pg',
        maxTenantConnections: CAP,
        evictionGracePeriodMs: 30_000,
      },
    })
  })

  group.teardown(async () => {
    setConfig(original)
  })

  test('concurrent writes across more tenants than the cap lose nothing and never cross-contaminate', async ({
    assert,
  }) => {
    const tenants: Array<{ id: string; model: TenantModelContract }> = []
    for (let i = 0; i < TENANT_COUNT; i++) {
      const row = await createTestTenant({ status: 'active' })
      const model = await findTenantModel(row.id)
      await driver.provision(model)
      await db
        .connection(`tenant_${row.id}`)
        .rawQuery(`CREATE TABLE notes (id serial PRIMARY KEY, owner text NOT NULL)`)
      tenants.push({ id: row.id, model })
    }

    // Interleave every tenant's writes into one concurrent batch so connections
    // are genuinely in flight together while the pool is over its cap.
    const writes = tenants.flatMap(({ id, model }) =>
      Array.from({ length: WRITES_PER_TENANT }, () => async () => {
        await driver.connect(model)
        await db.connection(`tenant_${id}`).table('notes').insert({ owner: id })
      })
    )
    await Promise.all(writes.map((w) => w()))

    // Every schema must hold exactly its own rows: no loss, no leakage.
    for (const { id } of tenants) {
      const rows = await db.connection(`tenant_${id}`).from('notes').select('owner')
      assert.equal(
        rows.length,
        WRITES_PER_TENANT,
        `tenant ${id} must keep all ${WRITES_PER_TENANT} of its writes`
      )
      assert.isTrue(
        rows.every((r) => r.owner === id),
        `tenant ${id} schema must contain only its own rows`
      )
    }

    // The grace window let the pool exceed the cap rather than sever an active
    // connection: more than CAP tenant connections are still registered.
    const open = tenants.filter(({ id }) => db.manager.has(`tenant_${id}`)).length
    assert.isAbove(
      open,
      CAP,
      'in-use grace must let the pool exceed maxTenantConnections instead of releasing active connections'
    )

    for (const { id, model } of tenants) {
      await driver.destroy(model)
      await destroyTestTenant(id)
    }
  })
})
