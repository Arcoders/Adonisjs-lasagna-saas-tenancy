import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import redis from '@adonisjs/redis/services/main'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import { createInstalledTenant, dropAllTenants, waitFor } from '../_helpers.js'

/**
 * HARDENING — circuit breaker isolation, fail-fast, and persistence.
 *
 * `TenantGuardMiddleware` checks `CircuitBreakerService.isOpen(tenantId)` on
 * every tenant-scoped request and throws `CircuitOpenException` (→ 503
 * CIRCUIT_OPEN) when the tenant's breaker is OPEN. The breaker is a per-tenant
 * Opossum instance held on the singleton service, and every state transition is
 * persisted to Redis under `cb:state:<tenantId>` so it survives a restart.
 *
 * The guarantees exercised here:
 *   - one tenant's OPEN circuit makes ITS requests fail fast (503), while a
 *     sibling tenant keeps serving 200 (a bad schema does not take down others);
 *   - the OPEN state is persisted to Redis;
 *   - resetting the breaker restores normal 200 service.
 *
 * The cross-restart restore path (read `cb:state:` back on boot and re-open) is
 * proven at the service layer in
 * packages/core/tests/integration/services/circuit_breaker_service.spec.ts.
 */
test.group('hardening — circuit breaker isolation & persistence', (group) => {
  let cb: CircuitBreakerService
  let healthyId = ''
  let brokenId = ''

  group.setup(async () => {
    await dropAllTenants()
    cb = await app.container.make(CircuitBreakerService)
  })

  group.teardown(async () => {
    await cb?.destroy(brokenId).catch(() => {})
    await cb?.destroy(healthyId).catch(() => {})
    await dropAllTenants()
  })

  test('an OPEN circuit fails its tenant fast while a sibling stays healthy', async ({
    client,
    assert,
  }) => {
    const broken = await createInstalledTenant(client)
    const healthy = await createInstalledTenant(client)
    brokenId = broken.id
    healthyId = healthy.id

    // Baseline: both tenants serve 200 before any breaker is tripped.
    const beforeBroken = await client.get('/demo/connection').header('x-tenant-id', brokenId)
    const beforeHealthy = await client.get('/demo/connection').header('x-tenant-id', healthyId)
    beforeBroken.assertStatus(200)
    beforeHealthy.assertStatus(200)

    // Trip the broken tenant's breaker (the same primitive the doctor --fix and
    // failure-threshold paths drive). The healthy tenant's breaker is untouched.
    cb.getCircuit(brokenId).open()
    assert.isTrue(cb.isOpen(brokenId), 'broken tenant breaker must be OPEN')
    assert.isFalse(cb.isOpen(healthyId), 'healthy tenant breaker must remain CLOSED')

    // Fail fast: the broken tenant now gets 503 CIRCUIT_OPEN from the guard.
    const brokenReq = await client.get('/demo/connection').header('x-tenant-id', brokenId)
    brokenReq.assertStatus(503)
    assert.equal(brokenReq.body().error?.code, 'CIRCUIT_OPEN')

    // Isolation: the sibling tenant is completely unaffected.
    const healthyReq = await client.get('/demo/connection').header('x-tenant-id', healthyId)
    healthyReq.assertStatus(200)
    assert.equal(cb.getMetrics(brokenId)?.state, 'OPEN')

    // Persistence: the OPEN state is written to Redis (fire-and-forget on the
    // 'open' event), so a restarting process would restore it.
    await waitFor(
      async () => ((await redis.get(`cb:state:${brokenId}`)) === 'OPEN' ? true : null),
      { timeoutMs: 5000, description: 'cb:state OPEN persisted to Redis' }
    )

    // Recovery: closing the breaker restores normal 200 service immediately.
    cb.reset(brokenId)
    assert.isFalse(cb.isOpen(brokenId), 'breaker must be CLOSED after reset')
    const recovered = await client.get('/demo/connection').header('x-tenant-id', brokenId)
    recovered.assertStatus(200)
    assert.equal(cb.getMetrics(brokenId)?.state, 'CLOSED')
  }).timeout(30_000)
})
