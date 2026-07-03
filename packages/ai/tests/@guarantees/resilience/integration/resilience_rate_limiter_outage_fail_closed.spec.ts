import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'
import { randomUUID } from 'node:crypto'
import { consumeRateLimit } from '@adonisjs-lasagna/saas-tenancy/services'
import AiRateLimiter, { aiRateLimitKey } from '../../../../src/services/ai_rate_limiter.js'
import AIException from '../../../../src/exceptions/ai_exception.js'

/**
 * WS-AI-8 / 1B — the BYOK per-key rate-limit rail fails CLOSED under a real Redis
 * outage. Existing coverage proves the rail with a stubbed consumer
 * (resilience_stream_extension) and proves the window bites on healthy real Redis
 * (security_cost_governor_bites_real_redis); the gap is the rail composed with the
 * REAL `consumeRateLimit` when Redis itself is down. An AI cost surface must never
 * run unmetered when the limiter is blind, so an outage is a 503
 * `rate_limit_unavailable`, never a silent pass. A healthy control hit confirms the
 * `ext:ai:*` bucket is still recorded when Redis is up.
 */

/**
 * A redis whose rate-limit pipeline builds normally but whose `exec()` rejects with
 * a connection error, the realistic shape of a mid-flight outage. `consumeRateLimit`
 * awaits `pipeline.exec()`, so the rejection surfaces through the awaited call (never
 * a stray unhandled rejection).
 */
const outageRedis = {
  pipeline() {
    const chain: Record<string, unknown> = {}
    for (const method of ['zremrangebyscore', 'zadd', 'zcard', 'expire']) {
      chain[method] = () => chain
    }
    chain.exec = async () => {
      const err = new Error('read ECONNRESET') as Error & { code?: string }
      err.code = 'ECONNRESET'
      throw err
    }
    return chain
  },
} as never

test.group('AI rate limiter fails closed under a real Redis outage (1B)', (group) => {
  const tenantId = randomUUID()
  const fingerprint = 'fp-1b'
  const key = aiRateLimitKey('chat', tenantId, fingerprint)

  group.each.teardown(async () => {
    await redis.del(key).catch(() => {})
  })

  test('a limiter-backend outage through consumeRateLimit is a 503 rate_limit_unavailable', async ({
    assert,
  }) => {
    const limiter = new AiRateLimiter({
      consume: (args) => consumeRateLimit({ getRedis: async () => outageRedis, ...args }),
      policy: { limit: 5, windowSeconds: 60 },
    })

    let threw: unknown
    try {
      await limiter.check({ op: 'chat', tenantId, fingerprint })
    } catch (err) {
      threw = err
    }

    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'rate_limit_unavailable')
    assert.equal((threw as AIException).httpStatus, 503)
    assert.equal(await redis.zcard(key), 0, 'a refused-closed check left no bucket entry behind')
  })

  test('a throwing consumer alone is enough to fail closed (the rail, isolated)', async ({
    assert,
  }) => {
    const limiter = new AiRateLimiter({
      consume: async () => {
        throw new Error('backend down')
      },
      policy: { limit: 5, windowSeconds: 60 },
    })
    let threw: unknown
    try {
      await limiter.check({ op: 'chat', tenantId, fingerprint })
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'rate_limit_unavailable')
  })

  test('control: on healthy Redis the check records the ext:ai bucket', async ({ assert }) => {
    const limiter = new AiRateLimiter({
      consume: (args) => consumeRateLimit({ getRedis: async () => redis, ...args }),
      policy: { limit: 5, windowSeconds: 60 },
    })
    await limiter.check({ op: 'chat', tenantId, fingerprint })
    assert.isAbove(await redis.zcard(key), 0, 'the healthy bucket recorded the hit')
  })
})
