import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { getActiveDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../../../integration/helpers/tenant.js'

/**
 * Release every registered tenant connection from BOTH the Lucid manager and the
 * driver's in-use LRU, so the hard-cap admission test starts from a known-empty
 * slate. `driver.disconnect()` clears both; `manager.release()` alone would leave
 * the LRU populated and `atHardLimit()` would see stale entries. Connection names
 * are `tenantConnectionNamePrefix + id`.
 */
async function clearTenantConnections(): Promise<void> {
  const prefix = getConfig().tenantConnectionNamePrefix
  const driver = await getActiveDriver()
  const manager: any = (db as any).manager
  const names: string[] = []
  for (const [name] of manager.connections) {
    if (String(name).startsWith(prefix)) names.push(String(name))
  }
  for (const name of names) {
    await driver.disconnect({ id: name.slice(prefix.length) } as any)
  }
}

/**
 * The hard cap (isolation.enforceConnectionCap) makes driver.connect() throw
 * TenantConnectionLimitException (503) when the cap is reached and nothing is
 * evictable. The universal middleware used to swallow that and degrade the
 * request to central mode; it must now surface the 503 instead.
 */
test.group('UniversalMiddleware — hard connection cap (integration)', (group) => {
  let savedConfig: any

  group.each.setup(async () => {
    // The config singleton is deep-frozen (config immutability), so an override
    // must re-seed the whole config via setConfig (permitted outside production)
    // rather than mutating the frozen object in place. Hard cap of 1, a long
    // grace so the single open connection is never evictable, and a fresh (empty)
    // connection registry.
    savedConfig = getConfig()
    setConfig({
      ...savedConfig,
      isolation: {
        ...(savedConfig.isolation ?? {}),
        enforceConnectionCap: true,
        maxTenantConnections: 1,
        evictionGracePeriodMs: 60_000,
      },
    })
    await clearTenantConnections()
  })

  group.each.teardown(async () => {
    await clearTenantConnections()
    setConfig(savedConfig)
  })

  test('no tenant header still serves central mode (200)', async ({ client }) => {
    const res = await client.get('/universal/ping')
    res.assertStatus(200)
  })

  test('a hard-cap-refused connection surfaces 503, not a central-mode 200', async ({ client }) => {
    const a = await createTestTenant({ status: 'active' })
    const b = await createTestTenant({ status: 'active' })
    try {
      // A is admitted: the registry is empty and the cap is 1, so connect()
      // succeeds and the route serves 200.
      const ra = await client.get('/universal/ping').header('x-tenant-id', a.id)
      ra.assertStatus(200)

      // B is a different tenant. The cap (1) is now reached and A is inside the
      // 60s grace window, so the driver refuses B with
      // TenantConnectionLimitException. The universal middleware must surface that
      // as a 503 rather than swallow it and serve B in central mode.
      const rb = await client.get('/universal/ping').header('x-tenant-id', b.id)
      rb.assertStatus(503)
      rb.assertBodyContains({ code: 'E_TENANT_CONNECTION_LIMIT' })
    } finally {
      await destroyTestTenant(a.id)
      await destroyTestTenant(b.id)
    }
  })
})
