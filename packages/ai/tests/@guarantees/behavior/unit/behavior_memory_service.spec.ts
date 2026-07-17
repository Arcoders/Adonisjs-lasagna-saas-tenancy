import { test } from '@japa/runner'
import ConversationMemoryService, {
  AI_MEMORY_DECRYPT_PREVIOUS_METRIC,
  AI_MEMORY_PERSIST_FAILED_METRIC,
  AI_MEMORY_UNDECRYPTABLE_METRIC,
  AI_MEMORY_UNREADABLE_METRIC,
  type ConversationMemoryDeps,
} from '../../../../src/services/conversation_memory_service.js'
import { FakeRedisLists } from '../../../helpers/fake_redis_lists.js'

/**
 * The conversation memory service (WS-AI-4) against a Map-backed ioredis double:
 * the atomic LIST append + bounded trim, the encrypt-on-write / decrypt-on-read
 * round-trip, the fail-SAFE degrade on a store outage, the OLD_APP_KEY rotation
 * grace, and the WS-AI-9 purge seams. Session identity (mint/resolve) is pure
 * crypto and never touches Redis.
 */

const TENANT = '11111111-1111-4111-8111-111111110001'
const MAC = Buffer.alloc(32, 9)

// A reversible fake enc_v2, so a stored blob is provably ciphertext (never plaintext).
const enc = (plain: string) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`
const dec = (cipher: string) => {
  if (!cipher.startsWith('enc:')) throw new Error('not current-key ciphertext')
  return Buffer.from(cipher.slice(4), 'base64').toString('utf8')
}

function serviceWith(redis: FakeRedisLists, extra: Partial<ConversationMemoryDeps> = {}) {
  const metrics: Array<{ name: string; tenantId: string }> = []
  const warns: string[] = []
  const svc = new ConversationMemoryService({
    getRedis: async () => redis,
    macKey: MAC,
    encryptMemory: enc,
    decryptMemory: dec,
    config: { maxTurns: 3, ttlMs: 1000 },
    metric: (tenantId, name) => metrics.push({ tenantId, name }),
    warn: (message) => warns.push(message),
    ...extra,
  })
  return { svc, metrics, warns }
}

test.group('behavior — conversation memory service', () => {
  test('mint then resolve returns the same storage key', ({ assert }) => {
    const { svc } = serviceWith(new FakeRedisLists())
    const minted = svc.mintSession(TENANT, 'user-a')
    const resolved = svc.resolveSession(minted.token, TENANT, 'user-a')
    assert.equal(resolved.storageKey, minted.storageKey)
    assert.match(minted.storageKey, /^ai:mem:/)
  })

  test('append then load round-trips the exchange as flat user/assistant turns', async ({
    assert,
  }) => {
    const { svc } = serviceWith(new FakeRedisLists())
    const { storageKey } = svc.mintSession(TENANT, 'user-a')

    await svc.append(TENANT, storageKey, { user: 'q1', assistant: 'a1' })
    await svc.append(TENANT, storageKey, { user: 'q2', assistant: 'a2' })

    assert.deepEqual(await svc.load(TENANT, storageKey), [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ])
  })

  test('each stored element is ciphertext, never plaintext (encryption on every write)', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists()
    const { svc } = serviceWith(redis)
    const { storageKey } = svc.mintSession(TENANT, 'user-a')

    await svc.append(TENANT, storageKey, { user: 'secret question', assistant: 'secret answer' })

    const stored = redis.data.get(storageKey)!
    assert.lengthOf(stored, 1)
    assert.match(stored[0]!, /^enc:/, 'the stored blob must be ciphertext')
    assert.notInclude(stored[0], 'secret question', 'plaintext must never be stored')
    assert.notInclude(stored[0], 'secret answer')
    assert.equal(redis.ttls.get(storageKey), 1000, 'the sliding TTL is set on append')
  })

  test('the turn list is bounded to maxTurns exchanges (LTRIM drops the oldest)', async ({
    assert,
  }) => {
    const { svc } = serviceWith(new FakeRedisLists()) // maxTurns: 3
    const { storageKey } = svc.mintSession(TENANT, 'user-a')
    for (let i = 1; i <= 5; i++) {
      await svc.append(TENANT, storageKey, { user: `q${i}`, assistant: `a${i}` })
    }
    const turns = await svc.load(TENANT, storageKey)
    // Only the newest 3 exchanges survive (6 flat turns), oldest-first.
    assert.deepEqual(
      turns.map((t) => t.content),
      ['q3', 'a3', 'q4', 'a4', 'q5', 'a5']
    )
  })

  test('clear erases a session', async ({ assert }) => {
    const { svc } = serviceWith(new FakeRedisLists())
    const { storageKey } = svc.mintSession(TENANT, 'user-a')
    await svc.append(TENANT, storageKey, { user: 'q', assistant: 'a' })
    await svc.clear(storageKey)
    assert.deepEqual(await svc.load(TENANT, storageKey), [])
  })

  test('purgeUser erases only that principal; purgeTenant erases the whole tenant', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists()
    const { svc } = serviceWith(redis)
    const a = svc.mintSession(TENANT, 'user-a')
    const b = svc.mintSession(TENANT, 'user-b')
    await svc.append(TENANT, a.storageKey, { user: 'qa', assistant: 'aa' })
    await svc.append(TENANT, b.storageKey, { user: 'qb', assistant: 'ab' })

    await svc.purgeUser(TENANT, 'user-a')
    assert.isFalse(redis.data.has(a.storageKey), "user-a's memory is gone")
    assert.isTrue(redis.data.has(b.storageKey), "user-b's memory survives")

    await svc.purgeTenant(TENANT)
    assert.isFalse(redis.data.has(b.storageKey), 'the tenant purge erases the rest')
  })

  test('a store outage on load degrades to empty and records the metric + a content-free warn', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists({ down: true })
    const { svc, metrics, warns } = serviceWith(redis)
    const { storageKey } = svc.mintSession(TENANT, 'user-a')

    assert.deepEqual(await svc.load(TENANT, storageKey), [])
    assert.deepEqual(metrics, [{ tenantId: TENANT, name: AI_MEMORY_UNREADABLE_METRIC }])
    assert.lengthOf(warns, 1)
    assert.notInclude(warns[0], 'ai:mem', 'the warn carries no key or content')
  })

  test('a store outage on append never throws and records the persist-failed metric', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists({ down: true })
    const { svc, metrics } = serviceWith(redis)
    const { storageKey } = svc.mintSession(TENANT, 'user-a')

    await svc.append(TENANT, storageKey, { user: 'q', assistant: 'a' }) // must not throw
    assert.deepEqual(metrics, [{ tenantId: TENANT, name: AI_MEMORY_PERSIST_FAILED_METRIC }])
  })

  test('rotation grace: a blob under the previous key is read via decryptMemoryPrevious', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists()
    // "old key" ciphertext the CURRENT key cannot read.
    const encOld = (plain: string) => `old:${Buffer.from(plain, 'utf8').toString('base64')}`
    const decOld = (cipher: string) => {
      if (!cipher.startsWith('old:')) throw new Error('not old-key ciphertext')
      return Buffer.from(cipher.slice(4), 'base64').toString('utf8')
    }
    const { svc, metrics } = serviceWith(redis, { decryptMemoryPrevious: decOld })
    const { storageKey } = svc.mintSession(TENANT, 'user-a')
    // Pre-seed an exchange written under the previous APP_KEY.
    redis.data.set(storageKey, [encOld(JSON.stringify({ v: 1, u: 'q-old', a: 'a-old' }))])

    assert.deepEqual(await svc.load(TENANT, storageKey), [
      { role: 'user', content: 'q-old' },
      { role: 'assistant', content: 'a-old' },
    ])
    assert.deepEqual(metrics, [{ tenantId: TENANT, name: AI_MEMORY_DECRYPT_PREVIOUS_METRIC }])
  })

  test('without a grace key, an unreadable blob is dropped (not thrown) and records the undecryptable metric (H1)', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists()
    const { svc, metrics } = serviceWith(redis) // no decryptMemoryPrevious
    const { storageKey } = svc.mintSession(TENANT, 'user-a')
    redis.data.set(storageKey, ['corrupt-not-ciphertext'])

    assert.deepEqual(await svc.load(TENANT, storageKey), [])
    // H1: the silent drop must surface as a counter, not only a warn, so a botched
    // APP_KEY rotation dropping historical turns is visible on a metrics dashboard.
    assert.deepEqual(metrics, [{ tenantId: TENANT, name: AI_MEMORY_UNDECRYPTABLE_METRIC }])
  })

  test('both keys failing drops the turn and records the undecryptable metric once (H1)', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists()
    const decPrevAlsoFails = (): string => {
      throw new Error('previous key cannot read it either (grace expired / corruption)')
    }
    const { svc, metrics } = serviceWith(redis, { decryptMemoryPrevious: decPrevAlsoFails })
    const { storageKey } = svc.mintSession(TENANT, 'user-a')
    redis.data.set(storageKey, ['neither-key-can-read', 'nor-this-one'])

    assert.deepEqual(await svc.load(TENANT, storageKey), [])
    assert.deepEqual(metrics, [{ tenantId: TENANT, name: AI_MEMORY_UNDECRYPTABLE_METRIC }])
  })
})
