import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * HARDENING — circuit breaker AUTO-TRIP (WS-2 / circuit-breaker-never-auto-trips).
 *
 * The sibling spec (circuit_breaker.spec.ts) trips the breaker manually to prove
 * fail-fast + isolation. This proves the path that was actually broken: the
 * guard now FIRES the breaker on every tenant request, so repeated tenant-DB
 * failures trip it on their own (before the fix nothing fired it, so it stayed
 * CLOSED forever and a dead tenant DB surfaced as a raw 500 per request).
 *
 * We swap in a breaker whose connectivity probe always throws (a dead tenant
 * DB), drive real HTTP requests through the guard, and assert CLOSED -> repeated
 * 503 -> OPEN (fast-fail). The swap is local to this group and restored after.
 */
class AlwaysFailingProbeService extends CircuitBreakerService {
  protected buildProbe(): () => Promise<void> {
    return async () => {
      throw new Error('tenant db down (chaos)')
    }
  }
}

test.group('hardening — circuit breaker auto-trips on repeated DB failure', (group) => {
  let swapped: AlwaysFailingProbeService

  group.teardown(async () => {
    app.container.restore(CircuitBreakerService)
    await dropAllTenants()
  })

  test('repeated failing probes flip the breaker CLOSED -> OPEN (then fast-fail)', async ({
    client,
    assert,
  }) => {
    swapped = new AlwaysFailingProbeService()
    app.container.swap(CircuitBreakerService, () => swapped)

    const tenant = await createInstalledTenant(client)

    // Drive enough guarded requests to exceed volumeThreshold. Each one fires
    // the (failing) probe through the breaker; every response is a clean 503,
    // never a raw 500.
    for (let i = 0; i < 12; i++) {
      const res = await client.get('/demo/connection').header('x-tenant-id', tenant.id)
      res.assertStatus(503)
    }

    assert.isTrue(
      swapped.isOpen(tenant.id),
      'the breaker must auto-open after repeated probe failures'
    )
    assert.equal(swapped.getMetrics(tenant.id)?.state, 'OPEN')

    // Once OPEN, the guard fast-fails with CIRCUIT_OPEN (no probe executed).
    const fast = await client.get('/demo/connection').header('x-tenant-id', tenant.id)
    fast.assertStatus(503)
    assert.equal(fast.body().error?.code, 'CIRCUIT_OPEN')
  }).timeout(30_000)
})
