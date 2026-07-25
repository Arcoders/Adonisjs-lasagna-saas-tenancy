import { test } from '@japa/runner'
import ConversationMemoryService, {
  AI_MEMORY_UNDECRYPTABLE_METRIC,
  type ConversationMemoryDeps,
} from '../../../../src/services/conversation_memory_service.js'
import { FakeRedisLists } from '../../../helpers/fake_redis_lists.js'

/**
 * The memory seam is async and carries `tenantId`, so ONE
 * mode-agnostic service backs both `'app-key'` (fleet key, default) and `'tenant-dek'`
 * (a per-tenant DEK). This spec proves the two contract properties a per-tenant DEK path
 * relies on, at the seam level (the provider wires the real crypto DEK on top):
 *  - the tenant id reaches the seam, so the sealed blob is scoped to the right DEK;
 *  - a shredded/absent DEK (the seam throws) degrades a read to empty, fail-SAFE, exactly
 *    like today's store-outage posture, which is what makes a crypto-shred an erasure.
 *
 * The behavior-preserving proof for the sync->async change itself is the EXISTING memory
 * regression specs staying green; this spec only adds the tenant-scoped and shred cases.
 */

const TENANT_A = '11111111-1111-4111-8111-111111110001'
const TENANT_B = '22222222-2222-4222-8222-222222220002'
const MAC = Buffer.alloc(32, 9)

/**
 * A fake per-tenant-DEK seam: it prefixes the ciphertext with the tenant id, so a read
 * proves the blob was sealed under the SAME tenant it is loaded for. `shredded` makes the
 * open throw (a `dek_missing` after a crypto-shred).
 */
function tenantScopedSeam(
  opts: { shredded?: boolean } = {}
): Pick<ConversationMemoryDeps, 'encryptMemory' | 'decryptMemory'> {
  return {
    encryptMemory: async (tenantId, plaintext) => `dek(${tenantId}):${plaintext}`,
    decryptMemory: async (tenantId, ciphertext) => {
      if (opts.shredded) {
        const err = new Error('no live DEK') as Error & { code: string }
        err.code = 'dek_missing'
        throw err
      }
      const prefix = `dek(${tenantId}):`
      if (!ciphertext.startsWith(prefix)) throw new Error('sealed under a different tenant DEK')
      return ciphertext.slice(prefix.length)
    },
  }
}

function serviceWith(
  redis: FakeRedisLists,
  seam: Pick<ConversationMemoryDeps, 'encryptMemory' | 'decryptMemory'>
) {
  const metrics: Array<{ tenantId: string; name: string }> = []
  const svc = new ConversationMemoryService({
    getRedis: async () => redis,
    macKey: MAC,
    ...seam,
    config: { maxTurns: 5, ttlMs: 60_000 },
    metric: (tenantId, name) => metrics.push({ tenantId, name }),
  })
  return { svc, metrics }
}

test.group('conversation memory: tenant-scoped at-rest seam', () => {
  test('the tenant id reaches the seam and round-trips under that tenant', async ({ assert }) => {
    const redis = new FakeRedisLists()
    const { svc } = serviceWith(redis, tenantScopedSeam())
    const { storageKey } = svc.mintSession(TENANT_A, 'user-a')

    await svc.append(TENANT_A, storageKey, { user: 'q1', assistant: 'a1' })

    // The stored element is sealed under tenant A's DEK (the seam saw the right tenant id).
    assert.isTrue(redis.data.get(storageKey)!.every((el) => el.startsWith(`dek(${TENANT_A}):`)))
    assert.deepEqual(await svc.load(TENANT_A, storageKey), [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ])
  })

  test("a blob sealed under another tenant's DEK never opens (per-tenant blast radius)", async ({
    assert,
  }) => {
    const redis = new FakeRedisLists()
    const a = serviceWith(redis, tenantScopedSeam())
    const { storageKey } = a.svc.mintSession(TENANT_A, 'user-a')
    await a.svc.append(TENANT_A, storageKey, { user: 'secret', assistant: 'reply' })

    // Loading the SAME storage key for tenant B decodes nothing (the seam refuses a
    // cross-tenant DEK), and the mismatch surfaces as the undecryptable metric.
    const b = serviceWith(redis, tenantScopedSeam())
    assert.deepEqual(await b.svc.load(TENANT_B, storageKey), [])
    assert.deepEqual(b.metrics, [{ tenantId: TENANT_B, name: AI_MEMORY_UNDECRYPTABLE_METRIC }])
  })

  test('a shredded DEK degrades the read to empty (crypto-erase), fail-SAFE not 500', async ({
    assert,
  }) => {
    const redis = new FakeRedisLists()
    // Seed a turn while the DEK is live.
    const live = serviceWith(redis, tenantScopedSeam())
    const { storageKey } = live.svc.mintSession(TENANT_A, 'user-a')
    await live.svc.append(TENANT_A, storageKey, { user: 'q', assistant: 'a' })

    // After the tenant's memory DEK is shredded, the open throws and the load degrades to
    // empty (the conversation history is now cryptographically gone).
    const shredded = serviceWith(redis, tenantScopedSeam({ shredded: true }))
    assert.deepEqual(await shredded.svc.load(TENANT_A, storageKey), [])
  })
})
