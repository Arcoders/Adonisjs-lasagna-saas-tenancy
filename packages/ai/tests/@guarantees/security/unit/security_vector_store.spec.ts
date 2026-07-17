import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import VectorStoreService from '../../../../src/services/vector_store_service.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  snapshotAiGuardCounters,
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import { fakeVectorEnv, vec } from '../../../helpers/fake_vector_db.js'

const tenant = { id: 'tenant-a' } as unknown as TenantModelContract

function chunk(embedding: number[], contentHash = 'h1') {
  return { content: 'c', contentHash, metadata: {}, model: 'm', actor: null, embedding }
}

async function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function rejectedIds() {
  return snapshotAiGuardCounters()
    .rejected.filter((r) => r.value > 0)
    .map((r) => r.id)
}

test.group('VectorStoreService — isolation guards', (group) => {
  group.each.setup(() => {
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async () => {})
    return () => __setAiGuardDispatcherForTests(undefined)
  })

  test('refuses rowscope-pg placement (I1): logical isolation is too weak for embeddings', async ({
    assert,
  }) => {
    const store = new VectorStoreService(fakeVectorEnv({ kind: 'rowscope' }).deps)
    await assert.rejects(() => store.count(tenant), /rowscope isolation/)
    await settle()
    assert.include(rejectedIds(), 'guard.ai_rowscope_refused')
  })

  test('refuses a query whose tenant differs from the active tenancy scope (ContextSeal for raw SQL)', async ({
    assert,
  }) => {
    const store = new VectorStoreService(fakeVectorEnv({ activeScope: 'someone-else' }).deps)
    await assert.rejects(async () => {
      try {
        await store.count(tenant)
      } catch (error) {
        assert.instanceOf(error, AIException)
        assert.equal((error as AIException).aiCode, 'tenant_scope_mismatch')
        throw error
      }
    })
    await settle()
    assert.include(rejectedIds(), 'guard.ai_scope_mismatch')
  })

  test('a matching active scope (or none) passes the seal', async ({ assert }) => {
    const matched = new VectorStoreService(
      fakeVectorEnv({ activeScope: 'tenant-a', count: 3 }).deps
    )
    assert.equal(await matched.count(tenant), 3)
    const unbound = new VectorStoreService(fakeVectorEnv({ count: 7 }).deps)
    assert.equal(await unbound.count(tenant), 7)
  })

  test('refuses a vector whose length is not the index dimension', async ({ assert }) => {
    const store = new VectorStoreService(fakeVectorEnv({ dimension: 8 }).deps)
    await assert.rejects(() => store.insert(tenant, 'src', [chunk(vec(4))]), /index dimension is 8/)
    await settle()
    assert.include(rejectedIds(), 'guard.ai_dimension_mismatch')
  })

  test('refuses a vector carrying a non-finite value', async ({ assert }) => {
    const store = new VectorStoreService(fakeVectorEnv({ dimension: 3 }).deps)
    await assert.rejects(
      () => store.insert(tenant, 'src', [chunk([0.1, Number.NaN, 0.3])]),
      /dimension/
    )
  })
})

test.group('VectorStoreService — storage', (group) => {
  group.each.setup(() => {
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async () => {})
    return () => __setAiGuardDispatcherForTests(undefined)
  })

  test('routes to the connection the driver reports (schema-pg and database-pg alike)', async ({
    assert,
  }) => {
    for (const kind of ['schema', 'database', 'connection'] as const) {
      const env = fakeVectorEnv({ kind })
      await new VectorStoreService(env.deps).count(tenant)
      assert.deepEqual(env.connections, ['tenant_conn'])
      // The bare table name resolves via the connection's search_path; never a tenant_<id> literal.
      assert.isTrue(env.queries.every((q) => !/tenant_[0-9a-f]/i.test(q.sql)))
    }
  })

  test('enforces the embeddingCount cap atomically before writing (#18)', async ({ assert }) => {
    const env = fakeVectorEnv({ dimension: 8, count: 5 })
    const store = new VectorStoreService(env.deps)
    await assert.rejects(
      () => store.insert(tenant, 'src', [chunk(vec(8))], { maxCount: 5 }),
      /plan limit embeddingCount/
    )
    await settle()
    assert.include(rejectedIds(), 'guard.ai_embedding_quota_exhausted')
    // The advisory lock and the count ran; the INSERT did NOT.
    assert.isTrue(env.queries.some((q) => q.sql.includes('pg_advisory_xact_lock')))
    assert.isTrue(env.queries.some((q) => q.sql.toLowerCase().includes('count(*)')))
    assert.isFalse(env.queries.some((q) => q.sql.toLowerCase().includes('insert into')))
  })

  test('inserts under the cap: advisory lock, ON CONFLICT DO NOTHING, then returns aligned ids', async ({
    assert,
  }) => {
    const env = fakeVectorEnv({
      dimension: 8,
      count: 0,
      insertedHashes: ['h1', 'h2'],
      existing: [
        { id: 'id-1', content_hash: 'h1' },
        { id: 'id-2', content_hash: 'h2' },
      ],
    })
    const store = new VectorStoreService(env.deps)
    const result = await store.insert(
      tenant,
      'doc-1',
      [chunk(vec(8, 1), 'h1'), chunk(vec(8, 2), 'h2')],
      { maxCount: 100 }
    )
    assert.deepEqual(result.ids, ['id-1', 'id-2'])
    assert.equal(result.inserted, 2)
    const insert = env.queries.find((q) => q.sql.toLowerCase().includes('insert into'))
    assert.match(insert!.sql, /ON CONFLICT \(source, content_hash\) DO NOTHING/i)
  })

  test('search scopes by (model, dim) and orders by cosine distance', async ({ assert }) => {
    const env = fakeVectorEnv({ dimension: 8 })
    const store = new VectorStoreService(env.deps)
    await store.search(tenant, { model: 'm', vector: vec(8) }, { limit: 5 })
    const q = env.queries[0]!
    assert.match(q.sql, /WHERE model = \? AND dim = \?/i)
    assert.match(q.sql, /ORDER BY embedding <=> \?::vector/i)
    assert.match(q.sql, /LIMIT \?/i)
  })

  test('deleteBySource removes a whole source (poisoning rollback, #3)', async ({ assert }) => {
    const env = fakeVectorEnv({ deleted: 4 })
    const removed = await new VectorStoreService(env.deps).deleteBySource(tenant, 'poisoned-doc')
    assert.equal(removed, 4)
    const del = env.queries[0]!
    assert.match(del.sql, /DELETE FROM ai_embeddings WHERE source = \?/i)
    assert.deepEqual(del.bindings, ['poisoned-doc'])
  })
})
