import { test } from '@japa/runner'
import {
  enforceRateLimit,
  __setRateLimitServiceResolverForTests,
  __setRateLimiterForTests,
} from '../../../../src/middleware/enforce_rate_limit_middleware.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import type { PlanDefinition } from '../../../../src/types/config.js'

/**
 * Fake QuotaService that returns a fixed plan. The factory resolves the service
 * through the test seam, so no booted container is needed.
 */
function fakeQuota(plan: PlanDefinition) {
  return {
    async getPlanFor() {
      return { name: 'test-plan', plan }
    },
  }
}

/**
 * Fake RateLimitMiddleware that records the synthesized options instead of
 * touching Redis, and proceeds to `next`.
 */
function fakeLimiter() {
  const calls: Array<{ options: any }> = []
  const limiter = {
    async handle(_ctx: any, next: () => Promise<void>, options: any) {
      calls.push({ options })
      return next()
    },
  }
  return { limiter, calls }
}

function makeCtx(tenant: any) {
  return { request: { tenant: async () => tenant } } as any
}

async function catchError(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  return undefined
}

test.group('enforceRateLimit middleware', (group) => {
  group.each.teardown(() => {
    __setRateLimitServiceResolverForTests(undefined)
    __setRateLimiterForTests(undefined)
  })

  test('synthesizes RateLimitMiddleware options from the plan and calls next', async ({
    assert,
  }) => {
    __setRateLimitServiceResolverForTests(async () =>
      fakeQuota({ limits: {}, rateLimit: { limit: 100, windowSeconds: 1 } })
    )
    const { limiter, calls } = fakeLimiter()
    __setRateLimiterForTests(() => limiter)

    let nextCalled = false
    await enforceRateLimit()(makeCtx(buildTestTenant()), async () => {
      nextCalled = true
    })

    assert.lengthOf(calls, 1)
    assert.deepEqual(calls[0].options, {
      limit: 100,
      windowSeconds: 1,
      prefix: 'rl',
      failOpen: undefined,
      bypassInTestEnv: undefined,
    })
    assert.isTrue(nextCalled)
  })

  test('per-route windowSeconds overrides the plan window', async ({ assert }) => {
    __setRateLimitServiceResolverForTests(async () =>
      fakeQuota({ limits: {}, rateLimit: { limit: 10, windowSeconds: 60 } })
    )
    const { limiter, calls } = fakeLimiter()
    __setRateLimiterForTests(() => limiter)

    await enforceRateLimit({ windowSeconds: 300 })(makeCtx(buildTestTenant()), async () => {})

    assert.equal(calls[0].options.limit, 10)
    assert.equal(calls[0].options.windowSeconds, 300)
  })

  test('per-route prefix and failOpen are forwarded', async ({ assert }) => {
    __setRateLimitServiceResolverForTests(async () =>
      fakeQuota({ limits: {}, rateLimit: { limit: 5, windowSeconds: 1 } })
    )
    const { limiter, calls } = fakeLimiter()
    __setRateLimiterForTests(() => limiter)

    await enforceRateLimit({ prefix: 'rl-api', failOpen: true })(
      makeCtx(buildTestTenant()),
      async () => {}
    )

    assert.equal(calls[0].options.prefix, 'rl-api')
    assert.equal(calls[0].options.failOpen, true)
  })

  test('throws a clear error when the plan declares no rateLimit, and does NOT call next', async ({
    assert,
  }) => {
    __setRateLimitServiceResolverForTests(async () =>
      fakeQuota({ limits: { apiCallsPerDay: 1000 } })
    )
    const { limiter, calls } = fakeLimiter()
    __setRateLimiterForTests(() => limiter)

    let nextCalled = false
    const err = await catchError(() =>
      enforceRateLimit()(makeCtx(buildTestTenant()), async () => {
        nextCalled = true
      })
    )

    assert.match((err as Error).message, /declares no `rateLimit` block/)
    assert.isFalse(nextCalled)
    assert.lengthOf(calls, 0)
  })

  test('rejects a non-positive plan limit (would block every request) and does NOT call next', async ({
    assert,
  }) => {
    __setRateLimitServiceResolverForTests(async () =>
      fakeQuota({ limits: {}, rateLimit: { limit: 0, windowSeconds: 60 } })
    )
    const { limiter, calls } = fakeLimiter()
    __setRateLimiterForTests(() => limiter)

    let nextCalled = false
    const err = await catchError(() =>
      enforceRateLimit()(makeCtx(buildTestTenant()), async () => {
        nextCalled = true
      })
    )

    assert.match((err as Error).message, /invalid rate limit/)
    assert.isFalse(nextCalled)
    assert.lengthOf(calls, 0)
  })

  test('rejects a non-positive window (would silently disable the limiter via EXPIRE)', async ({
    assert,
  }) => {
    __setRateLimitServiceResolverForTests(async () =>
      fakeQuota({ limits: {}, rateLimit: { limit: 10, windowSeconds: -1 } })
    )
    const { limiter, calls } = fakeLimiter()
    __setRateLimiterForTests(() => limiter)

    const err = await catchError(() =>
      enforceRateLimit()(makeCtx(buildTestTenant()), async () => {})
    )

    assert.match((err as Error).message, /invalid rate limit/)
    assert.lengthOf(calls, 0)
  })

  test('a per-route windowSeconds override of 0 is also rejected', async ({ assert }) => {
    __setRateLimitServiceResolverForTests(async () =>
      fakeQuota({ limits: {}, rateLimit: { limit: 10, windowSeconds: 60 } })
    )
    const { limiter, calls } = fakeLimiter()
    __setRateLimiterForTests(() => limiter)

    const err = await catchError(() =>
      enforceRateLimit({ windowSeconds: 0 })(makeCtx(buildTestTenant()), async () => {})
    )

    assert.match((err as Error).message, /invalid rate limit/)
    assert.lengthOf(calls, 0)
  })
})
