import { test } from '@japa/runner'
import { Buffer } from 'node:buffer'
import ConversationMemoryService from '../../../../src/services/conversation_memory_service.js'
import AiIdempotencyService from '../../../../src/gateway/idempotency.js'
import AiRateLimiter from '../../../../src/services/ai_rate_limiter.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import type { RunResilient } from '../../../../src/services/resilience_seam.js'
import {
  AI_RESILIENCE_OP_IDEMPOTENCY_LOOKUP,
  AI_RESILIENCE_OP_MEMORY_LOAD,
  AI_RESILIENCE_OP_RATE_LIMIT,
} from '../../../../src/constants.js'

/**
 * Wave 1.1: every request-path Redis read routes through ONE injected resilience
 * policy seam, so a dependency outage degrades by a named POLICY, not three
 * independent ad-hoc `try/catch` blocks. This pins the postures the seam must
 * preserve (memory `fail-open` to [], idempotency `fail-open` to null, rate-limit
 * `fail-closed` to a 503) AND proves the posture is genuinely config-driven: a
 * `fail-closed` override flips a read from degrade to throw, and a `fail-open`
 * override flips the rate limiter from throw to allow.
 */

const MAC = Buffer.alloc(32, 7)
const DOWN = () => {
  throw new Error('redis down')
}

test.group('resilience: the three request-path reads share one policy seam', () => {
  test('default postures on an outage: memory [], idempotency null, rate-limit 503', async ({
    assert,
  }) => {
    // Memory read fails open to an empty history (no runResilient injected ⇒ the
    // passthrough default, which reproduces the kernel policy semantics).
    const memory = new ConversationMemoryService({
      getRedis: async () => DOWN(),
      macKey: MAC,
      encryptMemory: async (_t, p) => p,
      decryptMemory: async (_t, c) => c,
      config: {},
    })
    const { storageKey } = memory.mintSession('t-1', 'principal-1')
    assert.deepEqual(await memory.load('t-1', storageKey), [])

    // Idempotency read fails open to no replay.
    const idem = new AiIdempotencyService({
      store: {
        async get() {
          return DOWN()
        },
        async set() {},
      },
      macKey: Buffer.alloc(32, 3),
    })
    assert.isNull(await idem.lookup({ tenantId: 't-1', principal: 'p', headerKey: 'k' }))

    // Rate limit fails CLOSED to a 503 rate_limit_unavailable.
    const limiter = new AiRateLimiter({
      consume: async () => DOWN(),
      policy: { limit: 5, windowSeconds: 60 },
    })
    let threw: unknown
    try {
      await limiter.check({ op: 'chat', tenantId: 't-1', fingerprint: 'fp' })
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'rate_limit_unavailable')
    assert.equal((threw as AIException).httpStatus, 503)
  })

  test('a config fail-closed override flips the idempotency read from degrade to throw', async ({
    assert,
  }) => {
    const idem = new AiIdempotencyService({
      store: {
        async get() {
          return DOWN()
        },
        async set() {},
      },
      macKey: Buffer.alloc(32, 3),
      resiliencePolicy: 'fail-closed',
    })
    await assert.rejects(() => idem.lookup({ tenantId: 't-1', principal: 'p', headerKey: 'k' }))
  })

  test('a config fail-open override flips the rate limiter from throw to allow', async ({
    assert,
  }) => {
    const limiter = new AiRateLimiter({
      consume: async () => DOWN(),
      policy: { limit: 5, windowSeconds: 60 },
      resiliencePolicy: 'fail-open',
    })
    // A blind limiter that a host chose to fail OPEN admits the request (the fallback
    // count 0 is under the limit), instead of the default 503.
    await assert.doesNotReject(() =>
      limiter.check({ op: 'chat', tenantId: 't-1', fingerprint: 'fp' })
    )
  })

  test('each read routes through the seam with its own operation label', async ({ assert }) => {
    const labels: string[] = []
    const spy: RunResilient = async (opts) => {
      labels.push(opts.operation)
      // Simulate the store op succeeding (the point is the routing, not the outage).
      return opts.run()
    }

    const memory = new ConversationMemoryService({
      getRedis: async () =>
        ({
          async lrange() {
            return []
          },
        }) as never,
      runResilient: spy,
      macKey: MAC,
      encryptMemory: async (_t, p) => p,
      decryptMemory: async (_t, c) => c,
      config: {},
    })
    const { storageKey } = memory.mintSession('t-2', 'principal-2')
    await memory.load('t-2', storageKey)

    const idem = new AiIdempotencyService({
      store: {
        async get() {
          return null
        },
        async set() {},
      },
      macKey: Buffer.alloc(32, 3),
      runResilient: spy,
    })
    await idem.lookup({ tenantId: 't-2', principal: 'p', headerKey: 'k' })

    const limiter = new AiRateLimiter({
      consume: async () => ({ count: 1 }),
      policy: { limit: 5, windowSeconds: 60 },
      runResilient: spy,
    })
    await limiter.check({ op: 'chat', tenantId: 't-2', fingerprint: 'fp' })

    assert.include(labels, AI_RESILIENCE_OP_MEMORY_LOAD)
    assert.include(labels, AI_RESILIENCE_OP_IDEMPOTENCY_LOOKUP)
    assert.include(labels, AI_RESILIENCE_OP_RATE_LIMIT)
  })
})
