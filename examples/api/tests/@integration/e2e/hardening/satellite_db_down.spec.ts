import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { getActiveDriver, CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * E3 — Chaos: the tenant database is unreachable during a satellite request.
 *
 * Core's connection_failure_503.spec.ts proves a resolved tenant whose DB is down
 * maps to a clean 503 (E_DEPENDENCY_UNAVAILABLE), never a raw 500 or a silent
 * central-mode serve. This complements it on a SATELLITE surface: the branding
 * endpoint resolves the tenant (which probes the tenant connection), so when the
 * active driver's connect() throws, the satellite request fails SAFE (503), and
 * once the connection is restored it recovers (200). Same failure-injection seam
 * as the core spec: patch `getActiveDriver().connect` to throw.
 */
test.group('e2e — satellite request when the tenant DB is down (E3)', (group) => {
  let restore: (() => void) | null = null
  let cb: CircuitBreakerService

  group.setup(async () => {
    await dropAllTenants()
    cb = await app.container.make(CircuitBreakerService)
  })
  group.each.teardown(() => {
    if (restore) restore()
  })
  group.teardown(() => dropAllTenants())

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

  test('a satellite endpoint returns 503 (not 500) while the tenant DB is down, then recovers', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)

    // Healthy baseline.
    const baseline = await client.get('/demo/branding').header('x-tenant-id', id)
    baseline.assertStatus(200)

    // Tenant DB unreachable: the satellite request must fail safe, not 500.
    await breakTenantConnect()
    const down = await client.get('/demo/branding').header('x-tenant-id', id)
    assert.equal(down.status(), 503, 'a satellite request to a down tenant must be 503, not 500')
    assert.notEqual(down.status(), 500, 'must never surface a raw 500')

    // Restore the connection (and clear any breaker the failed probe tripped) and
    // confirm the satellite surface recovers.
    if (restore) restore()
    cb.reset(id)
    const recovered = await client.get('/demo/branding').header('x-tenant-id', id)
    recovered.assertStatus(200)
  }).timeout(30_000)
})
