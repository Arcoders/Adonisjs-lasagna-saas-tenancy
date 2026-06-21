import { test } from '@japa/runner'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'

const TENANT = 'redis-down-tenant'

/**
 * Concern 3: the tenant circuit breaker keeps working when Redis is down.
 *
 * The breaker's decision path is in-memory + per-tenant (opossum + real DB
 * probes); Redis is only a best-effort cross-restart cache for the OPEN state.
 * Every persist/restore is wrapped in catch + logger.warn, so a Redis outage
 * must neither throw nor flip the breaker. The unit tier only ever sees Redis as
 * `null` (lazyRedis() -> null short-circuits BEFORE the catch), so the catch+log
 * branches in #persistState / #restorePersistedState / destroy are exercised
 * here, against a real booted app.
 *
 * We simulate the outage through the `getRedis()` seam (the same pattern
 * RateLimitMiddleware uses) rather than mutating the shared `@adonisjs/redis`
 * singleton: a global stub would leak into sibling specs that share this one
 * Ignitor and Redis. A subclass whose getRedis() rejects drives every persist /
 * restore / destroy call straight into its catch, with zero shared state touched.
 */
class DownRedisBreaker extends CircuitBreakerService {
  protected getRedis(): Promise<any> {
    return Promise.reject(new Error('redis down (simulated outage)'))
  }
}

test.group('CircuitBreakerService — survives a Redis outage (integration)', () => {
  test('force-open + reset never throw and reflect in-memory state while Redis is down', async ({
    assert,
  }) => {
    const svc = new DownRedisBreaker()
    const breaker = svc.getCircuit(TENANT)

    // open() fires the 'open' listener -> #persistState -> getRedis() rejects
    // (caught). The breaker's state is in-memory, not from Redis.
    assert.doesNotThrow(() => breaker.open())
    assert.isTrue(svc.isOpen(TENANT), 'breaker is OPEN from in-memory state, not Redis')

    // reset() -> breaker.close() -> 'close' listener -> #persistState (rejects, caught).
    assert.doesNotThrow(() => svc.reset(TENANT))
    assert.isFalse(svc.isOpen(TENANT))

    // Let the fire-and-forget persist listeners run their rejecting getRedis()
    // through the catch+log branch before we finish.
    await new Promise((r) => setTimeout(r, 30))

    // destroy() exercises the del path; getRedis() rejects, is caught, and the
    // call must still resolve.
    await assert.doesNotReject(() => svc.destroy(TENANT))
  })

  test('a fresh service restoring from a down Redis starts CLOSED and does not throw', async ({
    assert,
  }) => {
    // getCircuit triggers #restorePersistedState, which awaits the rejecting
    // getRedis(); it must swallow the error and leave the breaker CLOSED.
    const svc = new DownRedisBreaker()
    const breaker = svc.getCircuit(TENANT)
    await new Promise((r) => setTimeout(r, 50))

    assert.isFalse(breaker.opened, 'breaker starts CLOSED when restore cannot read Redis')
    assert.isFalse(svc.isOpen(TENANT))

    await svc.destroy(TENANT)
  })
})
