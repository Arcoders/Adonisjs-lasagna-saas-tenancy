import { test } from '@japa/runner'
import ConversationMemoryService, {
  AI_MEMORY_PURGED_DROP_METRIC,
  type ConversationMemoryDeps,
} from '../../../../src/services/conversation_memory_service.js'
import { FakeRedisLists } from '../../../helpers/fake_redis_lists.js'

/**
 * Memory purge hardening against the ioredis double: the purge seams
 * return a deleted-key COUNT, erase correctly under a host `keyPrefix`
 * (the silent-zero-delete footgun), reject an unsafe tenant id, and a
 * post-purge tombstone drops an in-flight turn that would re-populate erased
 * history.
 */

const TENANT = '11111111-1111-4111-8111-111111110001'
const MAC = Buffer.alloc(32, 9)
const enc = async (_tenantId: string, plain: string) =>
  `enc:${Buffer.from(plain, 'utf8').toString('base64')}`
const dec = async (_tenantId: string, cipher: string) => {
  if (!cipher.startsWith('enc:')) throw new Error('not ciphertext')
  return Buffer.from(cipher.slice(4), 'base64').toString('utf8')
}

function serviceWith(redis: FakeRedisLists, extra: Partial<ConversationMemoryDeps> = {}) {
  const metrics: Array<{ name: string; tenantId: string }> = []
  const svc = new ConversationMemoryService({
    getRedis: async () => redis,
    macKey: MAC,
    encryptMemory: enc,
    decryptMemory: dec,
    config: { maxTurns: 5, ttlMs: 60_000 },
    metric: (tenantId, name) => metrics.push({ tenantId, name }),
    ...extra,
  })
  return { svc, metrics }
}

test.group('behavior: memory purge hardening', () => {
  test('purgeUser / purgeTenant return the number of session keys removed', async ({ assert }) => {
    const redis = new FakeRedisLists()
    const { svc } = serviceWith(redis)
    const a = svc.mintSession(TENANT, 'user-a')
    const b = svc.mintSession(TENANT, 'user-a')
    await svc.append(TENANT, a.storageKey, { user: 'q', assistant: 'r' })
    await svc.append(TENANT, b.storageKey, { user: 'q', assistant: 'r' })

    assert.equal(await svc.purgeUser(TENANT, 'user-a'), 2)
    assert.equal(await svc.purgeTenant(TENANT), 0) // already gone
  })

  test('purgeTenant erases keys under a host keyPrefix (no silent zero-delete)', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists({ keyPrefix: 'app:' })
    const { svc } = serviceWith(redis)
    const { storageKey } = svc.mintSession(TENANT, 'user-a')
    await svc.append(TENANT, storageKey, { user: 'q', assistant: 'r' })
    // The list is physically stored under the prefix (ioredis prefixes writes).
    assert.isTrue(redis.data.has(`app:${storageKey}`))

    const removed = await svc.purgeTenant(TENANT)
    assert.equal(removed, 1)
    assert.isFalse(redis.data.has(`app:${storageKey}`))
  })

  test('a malformed non-string keyPrefix fails the purge closed, never a false zero', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists()
    ;(redis.options as { keyPrefix: unknown }).keyPrefix = 123
    const { svc } = serviceWith(redis)
    await assert.rejects(() => svc.purgeTenant(TENANT), /keyPrefix/)
  })

  test('purgeUser rejects an unsafe tenant id', async ({ assert }) => {
    const { svc } = serviceWith(new FakeRedisLists())
    await assert.rejects(() => svc.purgeUser('not a uuid; drop table', 'user-a'))
  })

  test('a tombstone drops an in-flight turn started before the purge', async ({ assert }) => {
    const redis = new FakeRedisLists()
    const { svc, metrics } = serviceWith(redis)
    const { storageKey } = svc.mintSession(TENANT, 'user-a')

    const before = Date.now()
    await svc.purgeUser(TENANT, 'user-a') // stamps the user tombstone (>= before)
    const after = Date.now()

    // A turn whose request began BEFORE the purge is stale; it must be dropped.
    await svc.append(TENANT, storageKey, { user: 'late', assistant: 'late' }, before - 10)
    assert.deepEqual(await svc.load(TENANT, storageKey), [])
    assert.isTrue(metrics.some((m) => m.name === AI_MEMORY_PURGED_DROP_METRIC))

    // A genuinely fresh turn (started AFTER the purge) proceeds normally.
    await svc.append(TENANT, storageKey, { user: 'fresh', assistant: 'ok' }, after + 10)
    assert.deepEqual(await svc.load(TENANT, storageKey), [
      { role: 'user', content: 'fresh' },
      { role: 'assistant', content: 'ok' },
    ])
  })
})
