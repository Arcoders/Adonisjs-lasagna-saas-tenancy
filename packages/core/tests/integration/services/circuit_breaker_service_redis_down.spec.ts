import { test } from '@japa/runner'
import { CircuitBreakerService } from '@adonisjs-lasagna/saas-tenancy/services'
import app from '@adonisjs/core/services/app'
import redis from '@adonisjs/redis/services/main'

const TENANT = 'redis-down-tenant'
const KEY = `cb:state:${TENANT}`

/**
 * Concern 3: the tenant circuit breaker keeps working when Redis is down.
 *
 * The breaker's decision path is in-memory + per-tenant (opossum + real DB
 * probes); Redis is only a best-effort cross-restart cache for the OPEN state.
 * Every persist/restore is wrapped in catch + logger.warn, so a Redis outage
 * must neither throw nor flip the breaker. The unit tier only ever sees Redis as
 * `null` (lazyRedis() -> null short-circuits BEFORE the catch), so the catch+log
 * branches in #persistState / #restorePersistedState / destroy are exercised
 * here, against the real wired Redis singleton.
 *
 * We simulate the outage by making the three commands the breaker uses (setex,
 * get, del) reject, rather than physically disconnecting the connection: ioredis
 * defaults to an OFFLINE COMMAND QUEUE, so a disconnected client would QUEUE the
 * commands (risking a hang) instead of rejecting them, which would not exercise
 * the catch. Rejecting at the command boundary is the focused test of our
 * contract: "if the Redis call throws, log and carry on." This stub lives only
 * in this group and is restored in teardown, since it perturbs the shared
 * singleton every other spec in this Ignitor uses.
 */
test.group('CircuitBreakerService — survives a Redis outage (integration)', (group) => {
  const original: Record<'setex' | 'get' | 'del', any> = {} as any

  group.setup(() => {
    original.setex = (redis as any).setex
    original.get = (redis as any).get
    original.del = (redis as any).del
    const down = () => Promise.reject(new Error('redis down (simulated outage)'))
    ;(redis as any).setex = down
    ;(redis as any).get = down
    ;(redis as any).del = down
  })

  group.teardown(async () => {
    // MANDATORY restore — later specs share this singleton.
    ;(redis as any).setex = original.setex
    ;(redis as any).get = original.get
    ;(redis as any).del = original.del
    await redis.del(KEY).catch(() => {})
  })

  test('force-open + reset never throw and reflect in-memory state while Redis is down', async ({
    assert,
  }) => {
    // Guard: prove the outage stub actually took, so a passing test can never be
    // a false green where Redis was secretly healthy (and the catch branches
    // therefore never ran).
    let stubActive = false
    try {
      await redis.setex('cb:probe', 1, 'x')
    } catch {
      stubActive = true
    }
    assert.isTrue(stubActive, 'the simulated Redis outage must be active for this test to be meaningful')

    const svc = await app.container.make(CircuitBreakerService)
    const breaker = svc.getCircuit(TENANT)

    // open() fires the 'open' listener -> #persistState (setex rejects, caught).
    assert.doesNotThrow(() => breaker.open())
    assert.isTrue(svc.isOpen(TENANT), 'breaker is OPEN from in-memory state, not Redis')

    // reset() -> breaker.close() -> 'close' listener -> #persistState (rejects, caught).
    assert.doesNotThrow(() => svc.reset(TENANT))
    assert.isFalse(svc.isOpen(TENANT))

    // Let the fire-and-forget persist listeners run their rejecting setex through
    // the catch+log branch before we tear down.
    await new Promise((r) => setTimeout(r, 30))

    // destroy() exercises the del catch branch; must resolve, not reject.
    await assert.doesNotReject(() => svc.destroy(TENANT))
  })

  test('a fresh service restoring from a down Redis starts CLOSED and does not throw', async ({
    assert,
  }) => {
    // A brand-new instance (simulating a process restart) calls
    // #restorePersistedState via the rejecting get; it must swallow the error
    // and leave the breaker at its CLOSED default, never throwing.
    const fresh = new CircuitBreakerService()
    const breaker = fresh.getCircuit(TENANT)
    await new Promise((r) => setTimeout(r, 50))

    assert.isFalse(breaker.opened, 'breaker starts CLOSED when restore cannot read Redis')
    assert.isFalse(fresh.isOpen(TENANT))

    await fresh.destroy(TENANT)
  })
})
