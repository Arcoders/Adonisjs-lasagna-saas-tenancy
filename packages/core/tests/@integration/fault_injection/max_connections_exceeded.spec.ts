import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import {
  IsolationDriverRegistry,
  type SchemaPgDriver,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantConnectionLimitException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { createTestTenant, destroyTestTenant } from '../../helpers/tenant.js'

/**
 * Fault-injection tier (@integration/fault_injection): exhaust the per-tenant
 * connection budget and assert the driver fails CLEANLY.
 *
 * With `isolation.enforceConnectionCap` on, `maxTenantConnections` reached, and
 * every open connection still inside the eviction grace window (so the LRU has no
 * idle victim to release), `SchemaPgDriver.connect()` must refuse a NEW tenant
 * connection by throwing the typed `TenantConnectionLimitException` (HTTP 503),
 * NOT by letting a raw pg error (a `too many clients` / `max_connections`
 * surprise from the server) escape. The throw site is
 * `packages/core/src/services/isolation/schema_pg_driver.ts:149`
 * (`if (!opts.bypassHardCap && this.#lru.atHardLimit()) throw new
 * TenantConnectionLimitException()`), gated by `ConnectionLru.atHardLimit()` in
 * `packages/core/src/services/isolation/connection_lru.ts:109`.
 *
 * Imports follow the @integration convention (the public `@adonisjs-lasagna/...`
 * subpaths, which resolve to the compiled ./build via the package exports map)
 * rather than `src/...`, so this spec exercises the SAME build the rest of the
 * gating suite does. The test/fixture helpers stay relative: this file sits at
 * tests/@integration/fault_injection/, so the shared tenant helpers under
 * tests/integration/helpers/ are two hops up (`../../integration/...`).
 */
const TENANT_CONNECTION_LIMIT_CODE = 'E_TENANT_CONNECTION_LIMIT'

/**
 * Release every registered tenant connection from BOTH the Lucid manager and the
 * driver's in-use LRU so the hard-cap admission test starts from a known-empty
 * slate. `driver.disconnect()` clears both; releasing the manager alone would
 * leave the LRU populated and `atHardLimit()` would see stale entries. Connection
 * names are `tenantConnectionNamePrefix + id`.
 */
async function clearTenantConnections(driver: SchemaPgDriver): Promise<void> {
  const prefix = getConfig().tenantConnectionNamePrefix
  const manager: any = (db as any).manager
  const names: string[] = []
  for (const [name] of manager.connections) {
    if (String(name).startsWith(prefix)) names.push(String(name))
  }
  for (const name of names) {
    await driver.disconnect({ id: name.slice(prefix.length) } as any)
  }
}

/** Count tenant connections currently registered in Lucid's manager. */
function openTenantConnections(): number {
  const prefix = getConfig().tenantConnectionNamePrefix
  const manager: any = (db as any).manager
  let count = 0
  for (const [name] of manager.connections) {
    if (String(name).startsWith(prefix)) count++
  }
  return count
}

test.group('SchemaPgDriver — connection budget exhausted (fault injection)', (group) => {
  let savedConfig: any
  let driver: SchemaPgDriver

  group.setup(async () => {
    // These tests drive provision()/connect() on the concrete driver, so the
    // active isolation driver must be schema-pg (provisionable). Mirror the
    // eviction-safety spec: resolve from the registry and narrow.
    const reg = await app.container.make(IsolationDriverRegistry)
    const active = reg.active()
    if (active.name !== 'schema-pg') {
      throw new Error(
        `connection-budget fault test requires schema-pg driver (got '${active.name}')`
      )
    }
    driver = active as SchemaPgDriver
  })

  group.each.setup(async () => {
    // The config singleton is deep-frozen, so an override must re-seed the whole
    // config via setConfig (permitted outside production) rather than mutate the
    // frozen object. Hard cap of 1 + a long grace window means the single open
    // connection is never evictable, so the next distinct tenant trips the cap.
    savedConfig = getConfig()
    setConfig({
      ...savedConfig,
      isolation: {
        ...(savedConfig.isolation ?? { driver: 'schema-pg' }),
        driver: 'schema-pg',
        enforceConnectionCap: true,
        maxTenantConnections: 1,
        evictionGracePeriodMs: 60_000,
      },
    })
    await clearTenantConnections(driver)
  })

  group.each.teardown(async () => {
    await clearTenantConnections(driver)
    setConfig(savedConfig)
  })

  test('a new tenant over the hard cap is refused with TenantConnectionLimitException, not a raw pg error', async ({
    assert,
  }) => {
    const a = await createTestTenant({ status: 'active' })
    const b = await createTestTenant({ status: 'active' })
    try {
      // A fills the single slot. provision() connects under bypassHardCap, so the
      // schema is created and A's connection is registered and freshly touched
      // (inside the 60s grace window).
      const tenantA = { id: a.id } as unknown as TenantModelContract
      await driver.provision(tenantA)
      assert.equal(openTenantConnections(), 1, 'A must occupy the single connection slot')

      // B is a different tenant. The cap (1) is reached and A is inside the grace
      // window, so the LRU has no evictable victim: atHardLimit() is true and
      // connect() must throw the typed 503 exception rather than register a second
      // pool (which on a real budget-exhausted server would surface as a raw pg
      // "too many clients" error). See schema_pg_driver.ts:149.
      const tenantB = { id: b.id } as unknown as TenantModelContract
      try {
        await driver.connect(tenantB)
        assert.fail('connect() over the hard cap must throw, not return a connection')
      } catch (error: any) {
        // The typed exception, NOT a raw pg error: assert the class AND the
        // contract surface (E_TENANT_CONNECTION_LIMIT / 503) the universal
        // middleware renders. A raw "too many clients" pg error would fail these.
        assert.instanceOf(
          error,
          TenantConnectionLimitException,
          `expected TenantConnectionLimitException, got ${error?.code ?? error?.message}`
        )
        assert.equal(error?.code, TENANT_CONNECTION_LIMIT_CODE)
        assert.equal(error?.status, 503, 'TenantConnectionLimitException renders HTTP 503')
      }

      // Accounting stays correct: the refused tenant left NO half-registered
      // connection behind, so only A's connection remains in the manager.
      assert.equal(
        openTenantConnections(),
        1,
        'a refused connection must not leak a second registration'
      )
    } finally {
      // destroy() bypasses the hard cap, so cleanup is never itself refused.
      await driver.destroy({ id: a.id } as unknown as TenantModelContract).catch(() => {})
      await driver.destroy({ id: b.id } as unknown as TenantModelContract).catch(() => {})
      await destroyTestTenant(a.id)
      await destroyTestTenant(b.id)
    }
  })

  test('a slot freed by disconnect lets the next tenant connect again', async ({ assert }) => {
    const a = await createTestTenant({ status: 'active' })
    const b = await createTestTenant({ status: 'active' })
    try {
      const tenantA = { id: a.id } as unknown as TenantModelContract
      const tenantB = { id: b.id } as unknown as TenantModelContract

      await driver.provision(tenantA)
      await driver.provision(tenantB) // provision bypasses the cap; creates B's schema

      // B's connect on the request path is refused while A holds the only slot.
      await driver.disconnect(tenantB) // drop B's provision-time registration
      assert.equal(openTenantConnections(), 1, 'only A should be registered before the retry')
      try {
        await driver.connect(tenantB)
        assert.fail('B must be refused while A occupies the single slot')
      } catch (error: any) {
        assert.instanceOf(error, TenantConnectionLimitException)
      }

      // Free A's slot. The cap is no longer reached, so B is admitted cleanly.
      await driver.disconnect(tenantA)
      const client = await driver.connect(tenantB)
      const result = await client.rawQuery('SELECT 1 as ok')
      const rows = Array.isArray(result.rows) ? result.rows : (result as any).rows
      assert.equal(rows[0].ok, 1, 'B must serve a real query once a slot is free')
      assert.equal(openTenantConnections(), 1, 'exactly one tenant connection after the retry')
    } finally {
      await driver.destroy({ id: a.id } as unknown as TenantModelContract).catch(() => {})
      await driver.destroy({ id: b.id } as unknown as TenantModelContract).catch(() => {})
      await destroyTestTenant(a.id)
      await destroyTestTenant(b.id)
    }
  })
})
