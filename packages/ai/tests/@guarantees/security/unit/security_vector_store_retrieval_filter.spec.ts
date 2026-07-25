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

/**
 * The retrievalFilter document-ACL WHERE clause on the vector
 * store's search. The (model, dim) scope and the tenant placement stay mandatory;
 * the filter only NARROWS, never widens, and every filter value is a `?` bind
 * (never interpolated), so a scope value can neither be SQL nor escape the
 * tenant's index.
 */

const tenant = { id: 'tenant-a' } as unknown as TenantModelContract
const query = { model: 'm', vector: vec(8) }

async function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function rejectedIds() {
  return snapshotAiGuardCounters()
    .rejected.filter((r) => r.value > 0)
    .map((r) => r.id)
}

const searchHit = { id: 'r1', content: 'nearest', metadata: { team: 'eng' }, distance: 0.12 }

test.group('VectorStoreService: retrievalFilter scope', (group) => {
  group.each.setup(() => {
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async () => {})
    return () => __setAiGuardDispatcherForTests(undefined)
  })

  test('no filter (or kind:all) adds no scope predicate; bindings are vector, model, dim, vector, limit', async ({
    assert,
  }) => {
    const env = fakeVectorEnv({ dimension: 8, searchHits: [searchHit] })
    const store = new VectorStoreService(env.deps)
    const matches = await store.search(tenant, query, { limit: 5, filter: { kind: 'all' } })

    const q = env.queries[0]!
    assert.notMatch(q.sql, /source in/i)
    assert.notMatch(q.sql, /metadata @>/i)
    assert.equal(q.bindings[1]!, 'm')
    assert.equal(q.bindings[2]!, 8)
    assert.equal(q.bindings[0]!, q.bindings[q.bindings.length - 2]!, 'the two vector binds match')
    assert.equal(q.bindings[q.bindings.length - 1]!, 5, 'the last bind is the limit')
    // The hit is mapped to a VectorMatch.
    assert.deepEqual(matches, [searchHit])
  })

  test('a sources allow-list becomes a parameterized IN (?, ?) with the sources as binds', async ({
    assert,
  }) => {
    const env = fakeVectorEnv({ dimension: 8, searchHits: [searchHit] })
    const store = new VectorStoreService(env.deps)
    await store.search(tenant, query, {
      limit: 5,
      filter: { kind: 'sources', sources: ['doc-a', 'doc-b'] },
    })

    const q = env.queries[0]!
    assert.match(q.sql, /AND source IN \(\?, \?\)/i)
    // model, dim, then the two source binds, in order.
    assert.deepEqual(q.bindings.slice(1, 5), ['m', 8, 'doc-a', 'doc-b'])
  })

  test('an EMPTY sources allow-list returns nothing WITHOUT issuing a query (no invalid IN ())', async ({
    assert,
  }) => {
    const env = fakeVectorEnv({ dimension: 8, searchHits: [searchHit] })
    const store = new VectorStoreService(env.deps)
    const matches = await store.search(tenant, query, {
      limit: 5,
      filter: { kind: 'sources', sources: [] },
    })
    assert.deepEqual(matches, [])
    assert.lengthOf(env.queries, 0, 'a zero-document scope never touches the database')
  })

  test('a metadata scope becomes a single jsonb containment bind', async ({ assert }) => {
    const env = fakeVectorEnv({ dimension: 8, searchHits: [searchHit] })
    const store = new VectorStoreService(env.deps)
    await store.search(tenant, query, {
      limit: 3,
      filter: { kind: 'metadata', match: { team: 'eng', level: 2 } },
    })

    const q = env.queries[0]!
    assert.match(q.sql, /AND metadata @> \?::jsonb/i)
    assert.include(q.bindings as unknown[], JSON.stringify({ team: 'eng', level: 2 }))
  })

  test('the satellite ContextSeal still fires on a filtered search (raw SQL bypasses the kernel seal)', async ({
    assert,
  }) => {
    const store = new VectorStoreService(fakeVectorEnv({ activeScope: 'someone-else' }).deps)
    await assert.rejects(
      () => store.search(tenant, query, { limit: 5, filter: { kind: 'all' } }),
      /does not match the active tenancy scope/
    )
    await settle()
    assert.include(rejectedIds(), 'guard.ai_scope_mismatch')
  })

  test('rowscope placement is refused for a filtered search too', async ({ assert }) => {
    const store = new VectorStoreService(fakeVectorEnv({ kind: 'rowscope' }).deps)
    await assert.rejects(
      () =>
        store.search(tenant, query, {
          limit: 5,
          filter: { kind: 'sources', sources: ['doc-a'] },
        }),
      /rowscope isolation/
    )
    await settle()
    assert.include(rejectedIds(), 'guard.ai_rowscope_refused')
  })
})
