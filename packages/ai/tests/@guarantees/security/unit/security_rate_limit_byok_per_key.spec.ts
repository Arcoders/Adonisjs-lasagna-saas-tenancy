import { test } from '@japa/runner'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import AiRateLimiter, {
  aiRateLimitKey,
  DISABLED_AI_RATE_LIMITER,
} from '../../../../src/services/ai_rate_limiter.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  snapshotAiGuardCounters,
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'

/**
 * The BYOK per-key request rate limiter (denial of wallet). It is a
 * DIFFERENT rail from the token cost reserve: it caps requests-per-window on a
 * provider key. Over the window is a fail-closed 429 that rides the guard
 * channel; a backend outage is a fail-closed 503 that does NOT (a dependency
 * outage, not a policy refusal). The bucket key binds the tenant so one tenant
 * can never exhaust another's window.
 */

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

async function capture(op: () => Promise<unknown>): Promise<unknown> {
  try {
    await op()
    return undefined
  } catch (err) {
    return err
  }
}

test.group('AI per-key rate limiter', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []

  group.each.setup(() => {
    captured = []
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
  })

  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('the bucket key binds op, tenant and the key fingerprint', ({ assert }) => {
    assert.equal(aiRateLimitKey('chat', 'tenant-1', 'fp-abc'), 'ext:ai:chat:tenant-1:fp-abc')
  })

  test('under the limit it passes and consumes exactly the right key', async ({ assert }) => {
    const seen: Array<{ key: string; windowSeconds: number }> = []
    const limiter = new AiRateLimiter({
      consume: async (args) => {
        seen.push(args)
        return { count: 3 }
      },
      policy: { limit: 5, windowSeconds: 60 },
    })

    await limiter.check({ op: 'chat', tenantId: 't1', fingerprint: 'fp' })

    assert.deepEqual(seen, [{ key: 'ext:ai:chat:t1:fp', windowSeconds: 60 }])
    assert.lengthOf(captured, 0, 'a passing request must not emit a guard event')
  })

  test('over the limit is a fail-closed 429 that emits guard.ai_rate_limited', async ({
    assert,
  }) => {
    const limiter = new AiRateLimiter({
      consume: async () => ({ count: 6 }),
      policy: { limit: 5, windowSeconds: 60 },
    })

    const threw = await capture(() =>
      limiter.check({ op: 'chat', tenantId: 't1', fingerprint: 'fp' })
    )
    await settle()

    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'rate_limited')
    assert.equal((threw as AIException).httpStatus, 429)
    assert.isTrue(
      (threw as AIException).isRetryable(),
      'a rate limit is transient: retry after the window'
    )

    assert.lengthOf(captured, 1, 'a policy denial rides the guard channel')
    assert.equal(captured[0]!.id, 'guard.ai_rate_limited')
    assert.equal(captured[0]!.severity, 'warn')
    assert.equal(captured[0]!.tenantId, 't1')

    const snapshot = snapshotAiGuardCounters()
    assert.equal(snapshot.rejected.find((r) => r.id === 'guard.ai_rate_limited')?.value, 1)
  })

  test('a limiter-backend outage is a fail-closed 503 and NOT a guard trip', async ({ assert }) => {
    const limiter = new AiRateLimiter({
      consume: async () => {
        throw new Error('redis down')
      },
      policy: { limit: 5, windowSeconds: 60 },
    })

    let threw: unknown
    try {
      await limiter.check({ op: 'chat', tenantId: 't1', fingerprint: 'fp' })
    } catch (err) {
      threw = err
    }
    await settle()

    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'rate_limit_unavailable')
    assert.equal((threw as AIException).httpStatus, 503)
    assert.lengthOf(captured, 0, 'an outage is a dependency failure, not a guard refusal')
  })

  test('with no policy configured it is a no-op: the consumer is never touched', async ({
    assert,
  }) => {
    let consumed = false
    const limiter = new AiRateLimiter({
      consume: async () => {
        consumed = true
        return { count: 0 }
      },
    })

    assert.isFalse(limiter.enabled)
    await limiter.check({ op: 'chat', tenantId: 't1', fingerprint: 'fp' })
    assert.isFalse(consumed, 'an absent policy skips the backend entirely')
  })

  test('the shared disabled limiter passes everything without a policy', async ({ assert }) => {
    assert.isFalse(DISABLED_AI_RATE_LIMITER.enabled)
    await DISABLED_AI_RATE_LIMITER.check({ op: 'chat', tenantId: 't1', fingerprint: 'fp' })
  })
})
