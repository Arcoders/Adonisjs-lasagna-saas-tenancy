import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import MultitenancyProvider from '@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'
import {
  setConfig,
  getConfig,
  TenantSuspended,
  resolveTenantRepository,
} from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant, updateTenantStatus } from '../../../helpers/tenant.js'

/**
 * Pins the resolution-cache lifecycle invalidation to the REAL provider wiring,
 * end to end through public surfaces. The unit spec proves the wiring FUNCTION
 * works against a fake emitter; this proves the part that actually regressed
 * (commit 64a09ac): the listener must be installed in `ready()` against the
 * CONTAINER emitter, not in `boot()` against the `services/emitter` module that
 * resolves to `undefined` mid-boot.
 *
 * The example app leaves `resolver.cache` off (so `ready()` early-returns), so
 * this group enables the cache, re-runs the provider's `ready()`, then drives a
 * real request lifecycle: warm the cache, mutate the tenant WITHOUT an event
 * (still served stale — proving the cache is live), then dispatch the real
 * `TenantSuspended` and prove the next request sees the new state. If the
 * wiring moved back to `boot()` / the module emitter, the final request would
 * still serve the stale active tenant and this test fails.
 */
test.group('resolution cache invalidation — real provider wiring (integration)', (group) => {
  // Restore the config swap even if the setup itself throws: Japa skips
  // `group.teardown` when `group.setup` errors, so the restore lives in a
  // try/catch (setup failure) plus the returned cleanup (success path). Capturing
  // `original` first means a partial setup can never leak the cache-enabled config
  // into the next spec.
  group.setup(async () => {
    const original = getConfig()
    const restore = () => {
      setConfig(original)
      app.config.set('multitenancy', original)
    }
    try {
      const enabled = {
        ...original,
        resolver: {
          ...original.resolver,
          cache: { enabled: true, ttlMs: 60_000, maxEntries: 100 },
        },
      }
      setConfig(enabled) // the request macro reads cache.enabled from the package singleton
      app.config.set('multitenancy', enabled) // provider.ready() reads it from app config
      await new MultitenancyProvider(app).ready() // wires invalidation against the container emitter
    } catch (err) {
      restore()
      throw err
    }
    return restore
  })

  test('a dispatched TenantSuspended evicts the cached tenant so the next request reflects it', async ({
    client,
    assert,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      // Warm: the active tenant lands in the per-process resolution cache.
      const warm = await client.get('/unguarded-tenant').header('x-tenant-id', tenant.id)
      warm.assertStatus(200)

      // Suspend in the DB WITHOUT dispatching a lifecycle event: the cache still
      // holds the active instance, so the request is served stale. This both
      // confirms the cache is actually live and sets up the eviction assertion.
      await updateTenantStatus(tenant.id, 'suspended')
      const stale = await client.get('/unguarded-tenant').header('x-tenant-id', tenant.id)
      assert.equal(
        stale.status(),
        200,
        'with the cache enabled and no invalidation event, the stale active tenant is still served'
      )

      // Dispatch the real lifecycle event through the container emitter. The
      // provider's ready() listener must evict the cached entry. Resolve the
      // real model so every fixture listener (audit, etc.) gets a full tenant.
      const repo = await resolveTenantRepository()
      const model = await repo.findById(tenant.id, true)
      assert.isNotNull(model)
      try {
        await TenantSuspended.dispatch(model!)
      } catch {
        // A throwing fixture listener must not mask the eviction assertion; the
        // invalidation listener runs independently of its siblings.
      }

      const fresh = await client.get('/unguarded-tenant').header('x-tenant-id', tenant.id)
      assert.equal(
        fresh.status(),
        403,
        'after TenantSuspended is dispatched the cache entry must be evicted and the suspended tenant rejected'
      )
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })
})
