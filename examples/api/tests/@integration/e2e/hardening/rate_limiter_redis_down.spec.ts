import { test } from '@japa/runner'
import { Socket } from 'node:net'
import { IncomingMessage } from 'node:http'
import testUtils from '@adonisjs/core/services/test_utils'
import { RateLimitMiddleware } from '@adonisjs-lasagna/saas-tenancy/middleware'
import { RateLimitUnavailableException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * HARDENING — rate-limit middleware fault injection: Redis is DOWN.
 *
 * Documented policy (fail-CLOSED by default). From
 * packages/core/src/middleware/rate_limit_middleware.ts:97 the effective policy
 * is `options.failOpen ?? this.configuredFailOpen()`, and configuredFailOpen()
 * (line 79-85) returns `false` unless `config.resilience.redis.rateLimit` is
 * `'fail-open'`. The demo app sets no such key (config/multitenancy.ts has no
 * `resilience.redis.rateLimit`), so the global policy is fail-closed. When the
 * sliding-window pipeline throws (Redis unreachable), the handle() catch runs
 * (rate_limit_middleware.ts:139-148):
 *
 *     } catch (error) {
 *       await warn('redis_pipeline_failed', error, { tenantId, key })
 *       await emitRedisDegraded(tenantId, failOpen, error)
 *       if (failOpen) return next()
 *       throw new RateLimitUnavailableException()
 *     }
 *
 * i.e. it LOGS the outage, emits a DependencyDegraded signal, and (fail-closed)
 * REJECTS the request with 503 E_RATE_LIMIT_UNAVAILABLE rather than letting an
 * unmetered flood through. `next()` is never called, so the request is blocked.
 *
 * How Redis-down is simulated: the demo app shares one Ignitor and one real
 * Redis across the whole e2e suite, so we must NOT take down the singleton (it
 * would leak into sibling specs). Instead we use the repo's established seam —
 * the same one used by packages/core's security_rate_limit.spec.ts and
 * resilience_circuit_breaker_service_redis_down.spec.ts — subclassing the
 * middleware so `getRedis()` rejects exactly as a refused connection would, and
 * forcing `isTestEnv()` false so the limiter runs instead of short-circuiting
 * under `app.inTest`.
 *
 * The request itself is a REAL demo-app HttpContext built via
 * testUtils.createHttpContext() carrying the `x-tenant-id` header for a REAL
 * installed tenant, so the middleware resolves the tenant, builds the real
 * bucket key, and drives the documented Redis-failure branch end to end.
 */
class RedisDownRateLimitMiddleware extends RateLimitMiddleware {
  // Same outage seam the core specs use: a refused Redis connection surfaces
  // as a rejected getRedis() before the pipeline can run.
  protected getRedis(): Promise<any> {
    return Promise.reject(new Error('ECONNREFUSED 127.0.0.1:6379 (simulated redis outage)'))
  }
  // The middleware short-circuits when app.inTest is true; force the production
  // codepath so the fail-closed branch is actually exercised.
  protected isTestEnv(): boolean {
    return false
  }
}

// Build a real demo-app HttpContext carrying the tenant header so the
// middleware resolves a genuine tenant id (the demo config uses the
// `header` resolver strategy with tenantHeaderKey = 'x-tenant-id').
async function ctxForTenant(tenantId: string) {
  const req = new IncomingMessage(new Socket())
  req.headers['x-tenant-id'] = tenantId
  req.method = 'GET'
  req.url = '/demo/connection'
  return testUtils.createHttpContext({ req })
}

test.group('hardening — rate-limit middleware fails CLOSED when Redis is down', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('a Redis outage rejects the request with 503 E_RATE_LIMIT_UNAVAILABLE (fail-closed)', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)

    const ctx = await ctxForTenant(id)
    const middleware = new RedisDownRateLimitMiddleware()

    let nextCalled = false
    let caught: unknown = null
    try {
      await middleware.handle(
        ctx,
        async () => {
          nextCalled = true
        },
        // bypassInTestEnv mirrors isTestEnv() being forced false: belt-and-braces
        // so the limiter runs. Default failOpen (unset) => global fail-closed policy.
        { limit: 5, windowSeconds: 60, bypassInTestEnv: true }
      )
    } catch (error) {
      caught = error
    }

    // Documented fail-closed behaviour: the request is BLOCKED, never passed
    // through. next() must not have run.
    assert.isFalse(nextCalled, 'fail-closed must NOT let the request through when Redis is down')
    assert.instanceOf(
      caught,
      RateLimitUnavailableException,
      'a Redis outage must surface as RateLimitUnavailableException'
    )
    assert.equal((caught as { status: number }).status, 503, 'the exception carries a 503 status')
    assert.equal(
      (caught as { code: string }).code,
      'E_RATE_LIMIT_UNAVAILABLE',
      'the exception carries the stable E_RATE_LIMIT_UNAVAILABLE code'
    )
  }).timeout(30_000)

  test('an explicit per-route failOpen overrides the policy and lets the request through', async ({
    client,
    assert,
  }) => {
    // The companion of the default: rate_limit_middleware.ts:146 `if (failOpen)
    // return next()` — an explicit per-route failOpen:true wins over the global
    // fail-closed policy, so the same Redis outage is bypassed (the request still
    // succeeds, unmetered). This proves the policy knob is actually wired.
    const { id } = await createInstalledTenant(client)

    const ctx = await ctxForTenant(id)
    const middleware = new RedisDownRateLimitMiddleware()

    let nextCalled = false
    let caught: unknown = null
    try {
      await middleware.handle(
        ctx,
        async () => {
          nextCalled = true
        },
        { limit: 5, windowSeconds: 60, bypassInTestEnv: true, failOpen: true }
      )
    } catch (error) {
      caught = error
    }

    assert.isNull(caught, 'fail-open must not throw on a Redis outage')
    assert.isTrue(nextCalled, 'fail-open lets the request through when Redis is down')
  }).timeout(30_000)
})
