import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import VectorStoreService from '../../../../src/services/vector_store_service.js'
import { fakeVectorEnv } from '../../../helpers/fake_vector_db.js'

/**
 * Vector purge: `purgeTenant` and `deleteByActor` run as
 * advisory-locked, batched `ctid IN (SELECT … LIMIT N)` loops so a huge index
 * erases in bounded chunks. `deleteByActor` filters by the exact `actor` hash
 * (per-user GDPR erasure), never a broad pattern.
 */

const tenant = { id: 'tenant-a' } as unknown as TenantModelContract

test.group('vector store purge', () => {
  test('purgeTenant takes the advisory lock and deletes by ctid batch', async ({ assert }) => {
    const env = fakeVectorEnv({ deleted: 5 })
    const removed = await new VectorStoreService(env.deps).purgeTenant(tenant)
    assert.equal(removed, 5)
    assert.isTrue(env.queries.some((q) => q.sql.includes('pg_advisory_xact_lock')))
    const del = env.queries.find((q) => q.sql.toLowerCase().startsWith('delete'))
    assert.match(
      del!.sql,
      /DELETE FROM ai_embeddings WHERE ctid IN \(SELECT ctid FROM ai_embeddings LIMIT \d+\)/i
    )
  })

  test('deleteByActor scopes to the exact actor hash (per-user erasure)', async ({ assert }) => {
    const env = fakeVectorEnv({ deleted: 2 })
    const removed = await new VectorStoreService(env.deps).deleteByActor(
      tenant,
      'sha256-of-principal'
    )
    assert.equal(removed, 2)
    const del = env.queries.find((q) => q.sql.toLowerCase().startsWith('delete'))
    assert.match(
      del!.sql,
      /WHERE ctid IN \(SELECT ctid FROM ai_embeddings WHERE actor = \? LIMIT \d+\)/i
    )
    assert.deepEqual(del!.bindings, ['sha256-of-principal'])
  })

  test('a per-batch statement_timeout is set inside the batch transaction', async ({ assert }) => {
    const env = fakeVectorEnv({ deleted: 1 })
    env.deps.purgeStatementTimeoutMs = 15000
    await new VectorStoreService(env.deps).purgeTenant(tenant)
    assert.isTrue(
      env.queries.some((q) => /SET LOCAL statement_timeout = 15000/i.test(q.sql)),
      'the batch transaction bounds a single statement, not the whole erasure'
    )
  })

  test('an empty tenant deletes nothing and does not loop', async ({ assert }) => {
    const env = fakeVectorEnv({ deleted: 0 })
    const removed = await new VectorStoreService(env.deps).purgeTenant(tenant)
    assert.equal(removed, 0)
    // Exactly one batch attempt (lock + delete), then the loop breaks on 0 < LIMIT.
    const deletes = env.queries.filter((q) => q.sql.toLowerCase().startsWith('delete'))
    assert.lengthOf(deletes, 1)
  })
})
