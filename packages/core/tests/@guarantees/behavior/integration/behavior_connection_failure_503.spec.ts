import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { getActiveDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import TenantRepository from '../../../fixtures/app/repositories/tenant_repository.js'

/**
 * A tenant backend outage must surface as a clean 503 `E_DEPENDENCY_UNAVAILABLE`
 * on the request path — not a raw 500, and (for the universal route) not a silent
 * degrade to central mode that would serve a tenant-targeted request without its
 * own data context. Two outage shapes are covered:
 *
 *   - tenant connection down: the active driver's `connect()` throws. Simulated
 *     by patching `connect` after the tenant is provisioned, so the registry
 *     lookup still succeeds and only the connection step fails.
 *   - central registry down: `repo.findById` throws (the schema-pg single-instance
 *     case, where Postgres backs both the registry and tenant schemas). Simulated
 *     by binding a repository whose lookup throws.
 *
 * `getActiveDriver()` returns the same driver instance the macro and the universal
 * middleware use, so patching it covers both code paths.
 */
test.group('Tenant backend outage → 503 fail-closed (integration)', (group) => {
  let restore: (() => void) | null = null

  async function breakTenantConnect(): Promise<void> {
    const driver: any = await getActiveDriver()
    const original = driver.connect.bind(driver)
    driver.connect = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
    }
    restore = () => {
      driver.connect = original
      restore = null
    }
  }

  /**
   * Run `fn` with TENANT_REPOSITORY bound to a repository whose lookups throw,
   * then restore the fixture's original transient factory (a fresh instance per
   * make, matching fixture_provider.ts) — not a captured singleton.
   */
  async function withThrowingRepository(fn: () => Promise<void>): Promise<void> {
    app.container.bind(TENANT_REPOSITORY as any, () => ({
      findById: async () => {
        throw new Error('central registry ECONNREFUSED 127.0.0.1:5432')
      },
      findByDomain: async () => {
        throw new Error('central registry ECONNREFUSED 127.0.0.1:5432')
      },
    }))
    try {
      await fn()
    } finally {
      app.container.bind(TENANT_REPOSITORY as any, () => new TenantRepository())
    }
  }

  group.each.teardown(async () => {
    if (restore) restore()
  })

  test('TenantGuard route returns 503 when the tenant DB is unreachable', async ({ client }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      await breakTenantConnect()
      const res = await client.get('/tenant/ping').header('x-tenant-id', tenant.id)
      res.assertStatus(503)
      res.assertBodyContains({ code: 'E_DEPENDENCY_UNAVAILABLE' })
    } finally {
      // destroyTestTenant needs a working connect, so restore before teardown.
      if (restore) restore()
      await destroyTestTenant(tenant.id)
    }
  })

  test('Universal route surfaces 503, not a central-mode 200, for a resolved tenant whose DB is down', async ({
    client,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      await breakTenantConnect()
      const res = await client.get('/universal/ping').header('x-tenant-id', tenant.id)
      res.assertStatus(503)
      res.assertBodyContains({ code: 'E_DEPENDENCY_UNAVAILABLE' })
    } finally {
      if (restore) restore()
      await destroyTestTenant(tenant.id)
    }
  })

  test('Universal route still serves central mode (200) with no tenant resolved while the driver is broken', async ({
    client,
  }) => {
    await breakTenantConnect()
    try {
      const res = await client.get('/universal/ping')
      res.assertStatus(200)
    } finally {
      if (restore) restore()
    }
  })

  test('TenantGuard route returns 503 when the central tenant registry is unreachable', async ({
    client,
  }) => {
    // schema-pg single instance: the registry lookup (`repo.findById`) fails
    // before `driver.connect` is ever reached. The macro must map that DB error
    // to a clean 503, not a raw 500.
    await withThrowingRepository(async () => {
      const res = await client.get('/tenant/ping').header('x-tenant-id', randomUUID())
      res.assertStatus(503)
      res.assertBodyContains({ code: 'E_DEPENDENCY_UNAVAILABLE' })
    })
  })

  test('Universal route fails closed (503), not central-mode 200, when the registry is unreachable', async ({
    client,
  }) => {
    // A request that named a tenant must not be served in central mode just
    // because the registry lookup threw. The universal middleware now fails
    // closed on a lookup throw (it still degrades when the tenant simply does
    // not exist, i.e. the lookup returns null).
    await withThrowingRepository(async () => {
      const res = await client.get('/universal/ping').header('x-tenant-id', randomUUID())
      res.assertStatus(503)
      res.assertBodyContains({ code: 'E_DEPENDENCY_UNAVAILABLE' })
    })
  })
})
