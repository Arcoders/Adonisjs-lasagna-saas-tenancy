import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import ConversationMemoryService from '../../../../src/services/conversation_memory_service.js'

/**
 * Conversation memory against the REAL Redis the app is wired to: the atomic
 * LIST append survives concurrency (no lost turns, the race the design fixes),
 * two tenants sharing a principal land in disjoint keys, and the WS-AI-9 purge
 * seams (per-user, per-tenant) erase on real infrastructure, not just a Map.
 */

let ready = false

function memoryService(): ConversationMemoryService {
  return new ConversationMemoryService({
    getRedis: () => app.container.make('redis'),
    macKey: Buffer.alloc(32, 5),
    // Identity-with-marker crypto: this spec exercises the real Redis LIST
    // semantics; the enc_v2 round-trip is covered in the unit tier.
    encryptMemory: (plain) => `e:${plain}`,
    decryptMemory: (cipher) => {
      if (!cipher.startsWith('e:')) throw new Error('not ciphertext')
      return cipher.slice(2)
    },
    config: { maxTurns: 5, ttlMs: 60_000 },
  })
}

test.group('conversation memory on real Redis (integration)', (group) => {
  let svc: ConversationMemoryService

  group.setup(async () => {
    try {
      const redis = await app.container.make('redis')
      await redis.ping()
      ready = true
    } catch {
      ready = false
    }
    svc = memoryService()
  })

  test('persists and reloads across turns in one session', async ({ assert }) => {
    const tenantId = '22222222-2222-4222-8222-222222220001'
    const { storageKey } = svc.mintSession(tenantId, 'user-a')
    try {
      await svc.append(tenantId, storageKey, { user: 'q1', assistant: 'a1' })
      await svc.append(tenantId, storageKey, { user: 'q2', assistant: 'a2' })
      assert.deepEqual(await svc.load(tenantId, storageKey), [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
      ])
    } finally {
      await svc.purgeTenant(tenantId)
    }
  }).skip(() => !ready, 'redis not available; runs in CI')

  test('two tenants sharing a principal never see each other', async ({ assert }) => {
    const t1 = '22222222-2222-4222-8222-2222222a0002'
    const t2 = '22222222-2222-4222-8222-2222222b0002'
    const a = svc.mintSession(t1, 'user-a')
    const b = svc.mintSession(t2, 'user-a')
    try {
      await svc.append(t1, a.storageKey, { user: 'secret-t1', assistant: 'ans' })
      assert.lengthOf(await svc.load(t2, b.storageKey), 0, 'tenant 2 sees nothing of tenant 1')
      assert.lengthOf(await svc.load(t1, a.storageKey), 2)
    } finally {
      await svc.purgeTenant(t1)
      await svc.purgeTenant(t2)
    }
  }).skip(() => !ready, 'redis not available; runs in CI')

  test('concurrent appends on one session lose no turn (atomic RPUSH)', async ({ assert }) => {
    const tenantId = '22222222-2222-4222-8222-222222220003'
    const { storageKey } = svc.mintSession(tenantId, 'user-a')
    try {
      await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          svc.append(tenantId, storageKey, { user: `q${i}`, assistant: `a${i}` })
        )
      )
      const turns = await svc.load(tenantId, storageKey)
      const users = turns.filter((t) => t.role === 'user').map((t) => t.content)
      assert.sameMembers(users, ['q0', 'q1', 'q2', 'q3', 'q4'], 'every concurrent turn survives')
    } finally {
      await svc.purgeTenant(tenantId)
    }
  }).skip(() => !ready, 'redis not available; runs in CI')

  test('purgeUser erases one principal; purgeTenant erases the rest', async ({ assert }) => {
    const tenantId = '22222222-2222-4222-8222-222222220004'
    const a = svc.mintSession(tenantId, 'user-a')
    const b = svc.mintSession(tenantId, 'user-b')
    try {
      await svc.append(tenantId, a.storageKey, { user: 'qa', assistant: 'aa' })
      await svc.append(tenantId, b.storageKey, { user: 'qb', assistant: 'ab' })

      await svc.purgeUser(tenantId, 'user-a')
      assert.lengthOf(await svc.load(tenantId, a.storageKey), 0, 'user-a purged')
      assert.lengthOf(await svc.load(tenantId, b.storageKey), 2, 'user-b survives')

      await svc.purgeTenant(tenantId)
      assert.lengthOf(await svc.load(tenantId, b.storageKey), 0, 'tenant purge erases the rest')
    } finally {
      await svc.purgeTenant(tenantId)
    }
  }).skip(() => !ready, 'redis not available; runs in CI')
})
