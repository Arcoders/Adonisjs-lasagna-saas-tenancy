import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { HealthService } from '@adonisjs-lasagna/saas-tenancy/health'

/**
 * WS-2 / readyz-no-tenant-connectivity-dimension (integration).
 *
 * The opt-in `tenant_pools` / `read_replicas` dimensions register as
 * NON-critical, so a saturated pool or a lagging replica must DEGRADE the pod
 * (200 + degraded body with the per-check `fail`) rather than 503 it out of
 * rotation entirely. This pins that HTTP contract; the registration gating is
 * unit-tested in default_checks_tenant_dimensions.spec.ts.
 *
 * Routes are mounted in the fixture at /ops.
 */
test.group('readyz tenant connectivity dimension (integration)', (group) => {
  group.each.teardown(async () => {
    const svc = await app.container.make(HealthService)
    svc.removeCheck('tenant_pools')
  })

  test('a failing non-critical tenant_pools check degrades but does not 503', async ({
    client,
    assert,
  }) => {
    const svc = await app.container.make(HealthService)
    svc.addCheck('tenant_pools', () => ({
      status: 'fail',
      durationMs: 0,
      message: 'all tenant pools saturated',
    }))

    const res = await client.get('/ops/readyz')
    res.assertStatus(200) // non-critical => degraded, still in rotation
    assert.equal(res.body().status, 'degraded')
    assert.equal(res.body().checks.tenant_pools.status, 'fail')
  })
})
