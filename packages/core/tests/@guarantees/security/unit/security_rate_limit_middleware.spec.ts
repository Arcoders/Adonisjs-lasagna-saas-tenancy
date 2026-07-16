import { test } from '@japa/runner'
import RateLimitMiddleware from '../../../../src/middleware/rate_limit_middleware.js'
import RateLimitUnavailableException from '../../../../src/exceptions/rate_limit_unavailable_exception.js'
import TooManyRequestsException from '../../../../src/exceptions/too_many_requests_exception.js'
import {
  setResolverRegistry,
  __resetResolverRegistryCacheForTests,
} from '../../../../src/extensions/request.js'
import TenantResolverRegistry from '../../../../src/services/resolvers/registry.js'
import {
  RESOLVER_CONTRACT_VERSION,
  ResolverHit,
  type TenantResolver,
} from '../../../../src/services/resolvers/resolver.js'
import { setupTestConfig } from '../../../helpers/config.js'

/** Seed a boot-like resolver chain of one custom synchronous resolver returning `id`. */
function seedResolver(name: string, resolve: TenantResolver['resolve']): void {
  const registry = new TenantResolverRegistry()
  // The routing chain requires resolveSync; the middleware tests always pass a
  // synchronous resolve, so it doubles as resolveSync.
  registry.register({
    name,
    contractVersion: RESOLVER_CONTRACT_VERSION,
    resolve,
    resolveSync: resolve as NonNullable<TenantResolver['resolveSync']>,
  })
  registry.setChain([name])
  setResolverRegistry(registry)
}

function makeRequest(headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    ip: () => '127.0.0.1',
    hostname: () => (lower['host'] ?? '').split(':')[0],
    url: () => '/',
    header: (key: string) => lower[key.toLowerCase()] ?? null,
    qs: () => ({}),
    input: () => undefined,
  } as any
}

function makeResponse() {
  const headers: Record<string, string> = {}
  return {
    header: (name: string, value: string) => {
      headers[name] = value
    },
    __headers: headers,
  } as any
}

class FailingPipeline {
  zremrangebyscore() {
    return this
  }
  zadd() {
    return this
  }
  zcard() {
    return this
  }
  expire() {
    return this
  }
  async exec() {
    throw new Error('ECONNREFUSED — Redis is down')
  }
}

class CountingPipeline {
  constructor(private count: number) {}
  zremrangebyscore() {
    return this
  }
  zadd() {
    return this
  }
  zcard() {
    return this
  }
  expire() {
    return this
  }
  async exec() {
    return [
      [null, 0],
      [null, 0],
      [null, this.count],
      [null, 1],
    ]
  }
}

// ioredis does NOT reject exec() when the backend is down. It RESOLVES with
// per-command [error, value] tuples. This is the real Redis-outage shape that
// the older middleware mistook for success (reading count=0 and failing open).
class ResolvedWithErrorsPipeline {
  zremrangebyscore() {
    return this
  }
  zadd() {
    return this
  }
  zcard() {
    return this
  }
  expire() {
    return this
  }
  async exec() {
    const err = new Error('ECONNREFUSED — Redis is down')
    return [
      [err, null],
      [err, null],
      [err, null],
      [err, null],
    ]
  }
}

class FailingRedisRateLimit extends RateLimitMiddleware {
  protected async getRedis(): Promise<any> {
    return { pipeline: () => new FailingPipeline() }
  }
}

class ResolvedErrorsRedisRateLimit extends RateLimitMiddleware {
  protected async getRedis(): Promise<any> {
    return { pipeline: () => new ResolvedWithErrorsPipeline() }
  }
}

class CountingRedisRateLimit extends RateLimitMiddleware {
  constructor(private count: number) {
    super()
  }
  protected async getRedis(): Promise<any> {
    return { pipeline: () => new CountingPipeline(this.count) }
  }
}

// Forces the in-test short-circuit branch on, regardless of `app.inTest`.
class TestEnvForcedRateLimit extends RateLimitMiddleware {
  protected async getRedis(): Promise<any> {
    throw new Error('getRedis must NOT be called when short-circuiting')
  }
  protected isTestEnv(): boolean {
    return true
  }
}

test.group('RateLimitMiddleware', (group) => {
  group.each.setup(() => {
    setupTestConfig()
  })

  test('fails CLOSED with 503 when Redis pipeline throws (default)', async ({ assert }) => {
    const m = new FailingRedisRateLimit()
    let nextCalled = false

    await assert.rejects(
      () =>
        m.handle(
          { request: makeRequest(), response: makeResponse() } as any,
          async () => {
            nextCalled = true
          },
          { limit: 10, windowSeconds: 60, bypassInTestEnv: true }
        ),
      RateLimitUnavailableException
    )
    assert.isFalse(nextCalled, 'must NOT proceed when the rate limiter is broken')
  })

  test('fails OPEN only when failOpen: true is explicitly set', async ({ assert }) => {
    const m = new FailingRedisRateLimit()
    let nextCalled = false

    await m.handle(
      { request: makeRequest(), response: makeResponse() } as any,
      async () => {
        nextCalled = true
      },
      { limit: 10, windowSeconds: 60, failOpen: true, bypassInTestEnv: true }
    )
    assert.isTrue(nextCalled, 'failOpen=true must let traffic through on backend errors')
  })

  test('fails CLOSED when exec() RESOLVES with per-command errors (Redis outage)', async ({
    assert,
  }) => {
    // The real ioredis outage shape: exec() resolves with [error, null] tuples
    // instead of rejecting. Must NOT be mistaken for success (count=0 read as open).
    const m = new ResolvedErrorsRedisRateLimit()
    let nextCalled = false

    await assert.rejects(
      () =>
        m.handle(
          { request: makeRequest(), response: makeResponse() } as any,
          async () => {
            nextCalled = true
          },
          { limit: 10, windowSeconds: 60, bypassInTestEnv: true }
        ),
      RateLimitUnavailableException
    )
    assert.isFalse(nextCalled, 'a resolved-with-errors pipeline must still fail closed')
  })

  test('fails OPEN on resolved-with-errors exec() only when failOpen: true', async ({ assert }) => {
    const m = new ResolvedErrorsRedisRateLimit()
    let nextCalled = false

    await m.handle(
      { request: makeRequest(), response: makeResponse() } as any,
      async () => {
        nextCalled = true
      },
      { limit: 10, windowSeconds: 60, failOpen: true, bypassInTestEnv: true }
    )
    assert.isTrue(nextCalled, 'failOpen=true must let traffic through on resolved-with-errors too')
  })

  test('throws TooManyRequestsException when count exceeds the limit', async ({ assert }) => {
    const m = new CountingRedisRateLimit(11)
    const response = makeResponse()
    let nextCalled = false

    await assert.rejects(
      () =>
        m.handle(
          { request: makeRequest(), response } as any,
          async () => {
            nextCalled = true
          },
          { limit: 10, windowSeconds: 60, bypassInTestEnv: true }
        ),
      TooManyRequestsException
    )
    assert.isFalse(nextCalled)
    assert.equal(response.__headers['Retry-After'], '60')
    assert.equal(response.__headers['X-RateLimit-Limit'], '10')
    assert.equal(response.__headers['X-RateLimit-Remaining'], '0')
  })

  test('passes through and sets headers when count is under the limit', async ({ assert }) => {
    const m = new CountingRedisRateLimit(3)
    const response = makeResponse()
    let nextCalled = false

    await m.handle(
      { request: makeRequest(), response } as any,
      async () => {
        nextCalled = true
      },
      { limit: 10, windowSeconds: 60, bypassInTestEnv: true }
    )

    assert.isTrue(nextCalled)
    assert.equal(response.__headers['X-RateLimit-Limit'], '10')
    assert.equal(response.__headers['X-RateLimit-Remaining'], '7')
    assert.isUndefined(response.__headers['Retry-After'])
  })

  test('short-circuits in test env unless bypassInTestEnv is set', async ({ assert }) => {
    // The Redis stub would throw if reached. With isTestEnv=true and no
    // bypassInTestEnv flag, the middleware MUST short-circuit before
    // touching the backend, proving the test bypass is wired up.
    const m = new TestEnvForcedRateLimit()
    let nextCalled = false

    await m.handle(
      { request: makeRequest(), response: makeResponse() } as any,
      async () => {
        nextCalled = true
      },
      { limit: 10, windowSeconds: 60 } // no bypassInTestEnv
    )

    assert.isTrue(nextCalled, 'in app.inTest mode the middleware must short-circuit')
  })
})

// Records the bucket key the middleware hands to Redis, so the attribution
// tests can assert WHICH tenant a request was counted against.
class KeyCapturingPipeline extends CountingPipeline {
  constructor(private capture: (key: string) => void) {
    super(1)
  }
  zadd(key?: string) {
    if (key) this.capture(key)
    return this
  }
}

class KeyCapturingRateLimit extends RateLimitMiddleware {
  capturedKey: string | undefined
  constructor(private contextTenantId?: string) {
    super()
  }
  protected currentTenantId(): string | undefined {
    return this.contextTenantId
  }
  protected async getRedis(): Promise<any> {
    return { pipeline: () => new KeyCapturingPipeline((k) => (this.capturedKey = k)) }
  }
}

// Attribution must prefer the canonical id the guard resolved
// (tenancy.currentId()) over the sync legacy resolver. Under domain-based
// strategies the resolver comes up empty and would collapse every tenant into
// one shared per-IP 'global' bucket.
test.group('RateLimitMiddleware — tenant attribution (P3-2)', (group) => {
  group.each.setup(() => {
    setupTestConfig()
  })
  group.each.teardown(() => {
    __resetResolverRegistryCacheForTests()
  })

  const opts = { limit: 10, windowSeconds: 60, bypassInTestEnv: true }

  // TRES-02: the bucket must be keyed by the tenant the resolver CHAIN serves, not
  // the raw header. A chain-blind regression (keying off `x-tenant-id`) would pass
  // every other test here but would bucket tenant B's flood under tenant A.
  test('attributes by the resolver chain, not the raw header', async ({ assert }) => {
    const served = '11111111-1111-4111-8111-111111111111'
    const header = '22222222-2222-4222-8222-222222222222'
    seedResolver('chain-served', () => ResolverHit.id(served))
    const m = new KeyCapturingRateLimit(undefined)
    await m.handle(
      { request: makeRequest({ 'x-tenant-id': header }), response: makeResponse() } as any,
      async () => {},
      opts
    )
    assert.equal(m.capturedKey, `rl:${served}:127.0.0.1`)
  })

  // The resolver UUID border only guards the BUILT-IN resolvers; a custom resolver
  // can mint any id. The middleware's own `isSafeIdentifier` seam guard is the last
  // line of defense: an id carrying ':' must never key a bucket verbatim.
  test('a custom resolver id carrying ":" degrades to the global bucket (seam guard)', async ({
    assert,
  }) => {
    seedResolver('evil', () => ResolverHit.id('victim:rl:127.0.0.1'))
    const m = new KeyCapturingRateLimit(undefined)
    await m.handle(
      { request: makeRequest(), response: makeResponse() } as any,
      async () => {},
      opts
    )
    assert.equal(
      m.capturedKey,
      'rl:global:127.0.0.1',
      'unsafe custom id must not be keyed verbatim'
    )
  })

  test('prefers the active tenancy context id over the request resolver', async ({ assert }) => {
    const m = new KeyCapturingRateLimit('ctx-tenant')
    await m.handle(
      { request: makeRequest({ 'x-tenant-id': 'header-tenant' }), response: makeResponse() } as any,
      async () => {},
      opts
    )
    assert.equal(m.capturedKey, 'rl:ctx-tenant:127.0.0.1')
  })

  test('falls back to the sync resolver when no tenancy context is active', async ({ assert }) => {
    const m = new KeyCapturingRateLimit(undefined)
    const tenant = '11111111-1111-4111-8111-111111111111'
    await m.handle(
      { request: makeRequest({ 'x-tenant-id': tenant }), response: makeResponse() } as any,
      async () => {},
      opts
    )
    assert.equal(m.capturedKey, `rl:${tenant}:127.0.0.1`)
  })

  test("collapses to the shared 'global' bucket only when nothing resolves", async ({ assert }) => {
    const m = new KeyCapturingRateLimit(undefined)
    await m.handle(
      { request: makeRequest(), response: makeResponse() } as any,
      async () => {},
      opts
    )
    assert.equal(m.capturedKey, 'rl:global:127.0.0.1')
  })

  // SECURITY (#4): a forged header carrying the ':' delimiter must NOT become a
  // bucket key (key-structure injection / cross-tenant attribution). It degrades
  // to the shared per-IP 'global' bucket instead of an attacker-chosen tenant.
  test('a colon-injected fallback header degrades to the global bucket', async ({ assert }) => {
    const m = new KeyCapturingRateLimit(undefined)
    await m.handle(
      {
        request: makeRequest({ 'x-tenant-id': 'victim:rl:127.0.0.1' }),
        response: makeResponse(),
      } as any,
      async () => {},
      opts
    )
    assert.equal(m.capturedKey, 'rl:global:127.0.0.1', 'unsafe id must not be keyed verbatim')
  })

  test('a non-SAFE_IDENT active context id degrades to the global bucket (seam guard)', async ({
    assert,
  }) => {
    const m = new KeyCapturingRateLimit('tenant:*:injected')
    await m.handle(
      { request: makeRequest(), response: makeResponse() } as any,
      async () => {},
      opts
    )
    assert.equal(m.capturedKey, 'rl:global:127.0.0.1')
  })
})

test.group('RateLimitMiddleware — global resilience.redis.rateLimit fallback', (group) => {
  group.each.setup(() => {
    setupTestConfig()
  })

  // The tests below seed non-default resilience policies into the
  // module-level config singleton; unit spec files share one process, so
  // reset to the base config rather than leaking 'fail-open'/'fail-closed'
  // into whichever file runs next.
  group.each.teardown(() => {
    setupTestConfig()
  })

  test('global fail-open applies when the route passes no failOpen option', async ({ assert }) => {
    setupTestConfig({ resilience: { redis: { rateLimit: 'fail-open' } } })
    const m = new FailingRedisRateLimit()
    let nextCalled = false

    await m.handle(
      { request: makeRequest(), response: makeResponse() } as any,
      async () => {
        nextCalled = true
      },
      { limit: 10, windowSeconds: 60 }
    )

    assert.isTrue(nextCalled, 'Redis outage must pass through under the global fail-open policy')
  })

  test('an explicit per-route failOpen: false wins over the global fail-open policy', async ({
    assert,
  }) => {
    setupTestConfig({ resilience: { redis: { rateLimit: 'fail-open' } } })
    const m = new FailingRedisRateLimit()

    await assert.rejects(
      () =>
        m.handle({ request: makeRequest(), response: makeResponse() } as any, async () => {}, {
          limit: 10,
          windowSeconds: 60,
          failOpen: false,
        }),
      RateLimitUnavailableException as any
    )
  })

  test('global fail-closed (the documented default) still 503s without a per-route option', async ({
    assert,
  }) => {
    setupTestConfig({ resilience: { redis: { rateLimit: 'fail-closed' } } })
    const m = new FailingRedisRateLimit()

    await assert.rejects(
      () =>
        m.handle({ request: makeRequest(), response: makeResponse() } as any, async () => {}, {
          limit: 10,
          windowSeconds: 60,
        }),
      RateLimitUnavailableException as any
    )
  })
})
