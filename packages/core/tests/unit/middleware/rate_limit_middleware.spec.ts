import { test } from '@japa/runner'
import RateLimitMiddleware from '../../../src/middleware/rate_limit_middleware.js'
import RateLimitUnavailableException from '../../../src/exceptions/rate_limit_unavailable_exception.js'
import TooManyRequestsException from '../../../src/exceptions/too_many_requests_exception.js'
import { setupTestConfig } from '../../helpers/config.js'

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

// ioredis does NOT reject exec() when the backend is down — it RESOLVES with
// per-command [error, value] tuples. This is the real Redis-outage shape that
// the older middleware mistook for success (reading count=0 → fail-open).
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
    // instead of rejecting. Must NOT be mistaken for success (count=0 → open).
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
    // touching the backend — proving the test bypass is wired up.
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
