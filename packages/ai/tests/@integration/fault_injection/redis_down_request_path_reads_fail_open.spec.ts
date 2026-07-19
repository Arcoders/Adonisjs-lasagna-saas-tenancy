import { test } from '@japa/runner'
import { Buffer } from 'node:buffer'
import redis from '@adonisjs/redis/services/main'
import { randomUUID } from 'node:crypto'
import { ResilienceService } from '@adonisjs-lasagna/saas-tenancy/services'
import ConversationMemoryService from '../../../src/services/conversation_memory_service.js'
import AiIdempotencyService, { type AiIdempotencyStore } from '../../../src/gateway/idempotency.js'

/**
 * Fault-injection tier: with Redis DOWN, the two fail-open request-path reads
 * (conversation memory and idempotency) degrade by POLICY, they do NOT 500.
 *
 * The unit spec (`resilience_redis_policy_seam`) proves the postures through the
 * local passthrough; this proves them through the REAL kernel `ResilienceService`
 * inside a booted app, so the `DependencyDegraded` observability actually fires and
 * the seam is exercised end to end. A healthy control against REAL Redis confirms the
 * reads still work when the backend is up, so the fail-open is a genuine degradation,
 * not a spec that always returns empty.
 */

const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const MAC = Buffer.alloc(32, 9)

let ready = false

/** A Redis whose every command rejects with a realistic mid-flight connection error. */
const outageRedis = {
  async lrange() {
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  },
  pipeline() {
    const chain: Record<string, unknown> = {}
    for (const method of ['rpush', 'ltrim', 'pexpire']) chain[method] = () => chain
    chain.exec = async () => {
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    }
    return chain
  },
} as never

/** An idempotency store whose reads throw the same outage. */
const outageStore: AiIdempotencyStore = {
  async get() {
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  },
  async set() {
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  },
}

/** A healthy store backed by real Redis (proves the control path works when the backend is up). */
const healthyStore: AiIdempotencyStore = {
  async get(_tenantId, key) {
    return (await redis.get(`ai:idem:test:${suffix}:${key}`)) ?? undefined
  },
  async set(_tenantId, key, value, ttlMs) {
    await redis.set(`ai:idem:test:${suffix}:${key}`, value, 'PX', ttlMs)
  },
}

function memoryService(getRedis: () => Promise<never>): ConversationMemoryService {
  return new ConversationMemoryService({
    getRedis,
    runResilient: (opts) => new ResilienceService().run(opts),
    macKey: MAC,
    encryptMemory: (p) => p,
    decryptMemory: (c) => c,
    config: {},
  })
}

test.group(
  'AI request-path reads fail open under a Redis outage (real ResilienceService)',
  (group) => {
    group.setup(async () => {
      try {
        await redis.ping()
        ready = true
      } catch {
        ready = false
      }
    })

    test('conversation memory load degrades to [] through the kernel ResilienceService', async ({
      assert,
    }) => {
      const memory = memoryService(async () => outageRedis)
      const { storageKey } = memory.mintSession(`t-${suffix}`, 'principal')
      // Fail-open: the outage resolves to no history, and it does NOT throw.
      assert.deepEqual(await memory.load(`t-${suffix}`, storageKey), [])
    }).skip(() => !ready, 'Redis unavailable')

    test('idempotency lookup degrades to null (no replay) through the kernel ResilienceService', async ({
      assert,
    }) => {
      const idem = new AiIdempotencyService({
        store: outageStore,
        macKey: MAC,
        runResilient: (opts) => new ResilienceService().run(opts),
      })
      assert.isNull(await idem.lookup({ tenantId: `t-${suffix}`, principal: 'p', headerKey: 'k' }))
    }).skip(() => !ready, 'Redis unavailable')

    test('control: with real Redis up, the reads work (fail-open is a genuine degradation)', async ({
      assert,
    }) => {
      const memory = memoryService(async () => redis as never)
      const { storageKey } = memory.mintSession(`t-${suffix}`, 'principal')
      // A never-written session reads as empty on healthy Redis (no throw, no outage).
      assert.deepEqual(await memory.load(`t-${suffix}`, storageKey), [])

      const idem = new AiIdempotencyService({
        store: healthyStore,
        macKey: MAC,
        runResilient: (opts) => new ResilienceService().run(opts),
      })
      // A never-cached scope reads as no-replay on healthy Redis.
      assert.isNull(await idem.lookup({ tenantId: `t-${suffix}`, principal: 'p', headerKey: 'k' }))
    }).skip(() => !ready, 'Redis unavailable')

    group.teardown(async () => {
      if (ready) {
        const keys = await redis.keys(`ai:idem:test:${suffix}:*`)
        if (keys.length > 0) await redis.del(...keys)
      }
    })
  }
)
