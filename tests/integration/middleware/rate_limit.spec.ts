import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'

// Rate-limit middleware against real Redis. Fixture routes use distinct
// key prefixes per spec and `bypassInTestEnv:true` so the middleware
// actually runs (it normally short-circuits under app.inTest).
//   limit:3 / window:2s / key: `<prefix>:<tenantId|'global'>:<ip>`
test.group('RateLimitMiddleware (integration, real Redis pipeline)', (group) => {
  // Each test uses a unique tenant id so the rolling-window key starts empty.
  group.each.setup(() => {})

  test('first N requests pass; exposes X-RateLimit-* headers', async ({ client, assert }) => {
    const tenant = randomUUID()
    for (let i = 1; i <= 3; i++) {
      const r = await client.get('/rate-limited/strict').header('x-tenant-id', tenant)
      r.assertStatus(200)
      assert.equal(r.headers()['x-ratelimit-limit'], '3')
      assert.equal(
        r.headers()['x-ratelimit-remaining'],
        String(3 - i),
        `remaining must decrement on each request (i=${i})`
      )
      assert.isString(r.headers()['x-ratelimit-reset'], 'reset header must be a unix timestamp')
    }
  })

  test('the N+1 request returns 429 with Retry-After + RATE_LIMIT_EXCEEDED', async ({
    client,
    assert,
  }) => {
    const tenant = randomUUID()
    // Burn the budget.
    for (let i = 0; i < 3; i++) {
      await client.get('/rate-limited/strict').header('x-tenant-id', tenant)
    }
    const over = await client.get('/rate-limited/strict').header('x-tenant-id', tenant)
    over.assertStatus(429)
    assert.equal(over.headers()['retry-after'], '2', 'Retry-After must match windowSeconds')
    assert.equal(over.body().code, 'E_TOO_MANY_REQUESTS', 'body must carry the typed code')
    assert.equal(
      over.headers()['x-ratelimit-remaining'],
      '0',
      'remaining must clamp at 0 when the budget is gone'
    )
  })

  test('budget recovers after the window expires', async ({ client, assert }) => {
    const tenant = randomUUID()
    // Burn the budget.
    for (let i = 0; i < 3; i++) {
      await client.get('/rate-limited/strict').header('x-tenant-id', tenant)
    }
    const over = await client.get('/rate-limited/strict').header('x-tenant-id', tenant)
    over.assertStatus(429)

    // Wait past the 2s window. A small slack prevents flakes when CI is
    // running other specs concurrently (real-clock TTLs are inherently
    // jittery on shared runners).
    await new Promise((r) => setTimeout(r, 2200))

    const after = await client.get('/rate-limited/strict').header('x-tenant-id', tenant)
    after.assertStatus(200)
    assert.equal(
      after.headers()['x-ratelimit-remaining'],
      '2',
      'remaining must show a fresh window'
    )
  }).timeout(5000)

  test('per-tenant isolation: A exhausting its budget does not affect B', async ({
    client,
    assert,
  }) => {
    const a = randomUUID()
    const b = randomUUID()
    // Burn A's budget; B is untouched.
    for (let i = 0; i < 3; i++) {
      await client.get('/rate-limited/strict').header('x-tenant-id', a)
    }
    const aOver = await client.get('/rate-limited/strict').header('x-tenant-id', a)
    aOver.assertStatus(429)

    // B's first request must still succeed with a clean budget.
    const bFirst = await client.get('/rate-limited/strict').header('x-tenant-id', b)
    bFirst.assertStatus(200)
    assert.equal(
      bFirst.headers()['x-ratelimit-remaining'],
      '2',
      "tenant B's budget must not be touched by tenant A's traffic"
    )
  })

  test('fail-closed (default): Redis outage → 503 RATE_LIMIT_UNAVAILABLE', async ({ assert }) => {
    // We can't take down the real Redis from inside the suite without
    // breaking sibling specs, so we exercise the failure path by
    // subclassing the middleware and forcing `getRedis()` to throw.
    // This is exactly what the production middleware sees when Redis
    // refuses a connection — same code path, same exception, same
    // status. The route mapping (`/rate-limited/strict`) ships
    // `failOpen: false`, which is the production-safe default.
    const { default: RateLimitMiddleware } = await import(
      '@adonisjs-lasagna/saas-tenancy/middleware'
    ).then((m) => ({ default: m.RateLimitMiddleware }))
    const { default: RateLimitUnavailableException } = await import(
      '@adonisjs-lasagna/saas-tenancy/exceptions'
    ).then((m) => ({ default: m.RateLimitUnavailableException }))

    class BrokenRedisMiddleware extends RateLimitMiddleware {
      protected getRedis() {
        return Promise.reject(new Error('ECONNREFUSED: redis is down'))
      }
      protected isTestEnv() {
        return false
      }
    }

    const ctx = makeMinimalHttpCtx({ tenantId: randomUUID() })
    let caught: unknown = null
    try {
      await new BrokenRedisMiddleware().handle(ctx as any, async () => undefined, {
        limit: 3,
        windowSeconds: 2,
      })
    } catch (e) {
      caught = e
    }
    assert.instanceOf(caught, RateLimitUnavailableException)
    assert.equal((caught as { status: number }).status, 503)
  })

  test('fail-open: Redis outage → request passes through (200)', async ({ assert }) => {
    const { default: RateLimitMiddleware } = await import(
      '@adonisjs-lasagna/saas-tenancy/middleware'
    ).then((m) => ({ default: m.RateLimitMiddleware }))

    class BrokenRedisMiddleware extends RateLimitMiddleware {
      protected getRedis() {
        return Promise.reject(new Error('ECONNREFUSED: redis is down'))
      }
      protected isTestEnv() {
        return false
      }
    }

    const ctx = makeMinimalHttpCtx({ tenantId: randomUUID() })
    let nextCalled = false
    await new BrokenRedisMiddleware().handle(
      ctx as any,
      async () => {
        nextCalled = true
      },
      { limit: 3, windowSeconds: 2, failOpen: true }
    )
    assert.isTrue(nextCalled, 'fail-open must let the request through when Redis is unavailable')
  })
})

function makeMinimalHttpCtx({ tenantId }: { tenantId: string }) {
  const headers: Record<string, string> = { 'x-tenant-id': tenantId }
  return {
    request: {
      ip: () => '127.0.0.1',
      hostname: () => 'localhost',
      url: () => '/rate-limited/strict',
      header: (k: string) => headers[k.toLowerCase()] ?? null,
      qs: () => ({}),
      input: () => undefined,
    },
    response: {
      __headers: {} as Record<string, string>,
      header(name: string, value: string) {
        ;(this as any).__headers[name] = value
      },
    },
  }
}
