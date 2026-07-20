import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import VectorStoreService from '../../../../src/services/vector_store_service.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { AI_EMBEDDING_CONTENT_UNDECRYPTABLE_METRIC } from '../../../../src/constants.js'
import {
  snapshotAiGuardCounters,
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import { fakeVectorEnv, fakeContentCipher, vec } from '../../../helpers/fake_vector_db.js'

/**
 * Wave 5 (data-at-rest, GATED): embeddings content-at-rest. The store seals `content`
 * (and optionally `metadata`) under an injected per-tenant seam before the bind, decrypts
 * the O(limit) rows a search returns, keeps `content_hash` on caller plaintext (so dedup
 * survives), refuses a metadata-scoped read over encrypted metadata, fails an ingest
 * CLOSED on a seal error (never plaintext), and drops an un-openable row fail-SAFE.
 * Default-off means byte-identical-to-today behavior, proven here beside the encrypted paths.
 */

const tenant = { id: 'tenant-a' } as unknown as TenantModelContract

function chunk(embedding: number[], contentHash = 'h1', content = 'c') {
  return { content, contentHash, metadata: { k: 'v' }, model: 'm', actor: null, embedding }
}

async function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function rejectedIds() {
  return snapshotAiGuardCounters()
    .rejected.filter((r) => r.value > 0)
    .map((r) => r.id)
}

/** A ready-to-insert env whose id-lookup returns a stable id for content_hash 'h1'. */
function insertableEnv(over: Parameters<typeof fakeVectorEnv>[0] = {}) {
  return fakeVectorEnv({
    dimension: 8,
    insertedHashes: ['h1'],
    existing: [{ id: 'id-1', content_hash: 'h1' }],
    ...over,
  })
}

test.group('VectorStoreService — content-at-rest (Wave 5)', () => {
  test('default-off: content is bound plaintext and metadata stays ?::jsonb (parity)', async ({
    assert,
  }) => {
    const env = insertableEnv()
    await new VectorStoreService(env.deps).insert(tenant, 'doc-1', [chunk(vec(8, 1))])
    const insert = env.queries.find((q) => q.sql.toLowerCase().includes('insert into'))!
    assert.match(insert.sql, /\?::jsonb/i)
    assert.notInclude(insert.sql.toLowerCase(), 'to_jsonb')
    // bindings per chunk: [source, contentHash, content, metadata, model, dim, actor, vector]
    assert.equal(insert.bindings[2], 'c')
    assert.equal(insert.bindings[3], JSON.stringify({ k: 'v' }))
  })

  test('default-off: a metadata serialization failure keeps its prior fatal propagation (not a seal 503)', async ({
    assert,
  }) => {
    // A BigInt/cycle in metadata is a permanent CALLER fault, not an at-rest seal outage.
    // On the encryption-off path it must NOT be repackaged as a retryable embedding_seal_failed.
    const env = insertableEnv()
    const badChunk = {
      content: 'c',
      contentHash: 'h1',
      metadata: { n: 1n } as unknown as Record<string, unknown>,
      model: 'm',
      actor: null,
      embedding: vec(8, 1),
    }
    let thrown: unknown
    try {
      await new VectorStoreService(env.deps).insert(tenant, 'doc-1', [badChunk])
    } catch (error) {
      thrown = error
    }
    assert.instanceOf(thrown, TypeError)
    assert.notInstanceOf(thrown, AIException)
  })

  test('encryptContent seals the content bind; content_hash is unchanged (dedup survives)', async ({
    assert,
  }) => {
    const env = insertableEnv({ encryptContent: true, cipher: fakeContentCipher() })
    await new VectorStoreService(env.deps).insert(tenant, 'doc-1', [chunk(vec(8, 1))])
    const insert = env.queries.find((q) => q.sql.toLowerCase().includes('insert into'))!
    assert.equal(
      insert.bindings[1],
      'h1',
      'content_hash hashes caller plaintext, untouched by sealing'
    )
    assert.equal(insert.bindings[2], 'enc:c', 'content column is sealed enc_v2 ciphertext')
    // Metadata was NOT encrypted, so it stays a plain jsonb bind.
    assert.match(insert.sql, /\?::jsonb/i)
    assert.equal(insert.bindings[3], JSON.stringify({ k: 'v' }))
  })

  test('encryptMetadata seals the metadata bind via to_jsonb(?::text)', async ({ assert }) => {
    const env = insertableEnv({ encryptMetadata: true, cipher: fakeContentCipher() })
    await new VectorStoreService(env.deps).insert(tenant, 'doc-1', [chunk(vec(8, 1))])
    const insert = env.queries.find((q) => q.sql.toLowerCase().includes('insert into'))!
    assert.match(insert.sql, /to_jsonb\(\?::text\)/i)
    assert.equal(insert.bindings[3], `enc:${JSON.stringify({ k: 'v' })}`)
    // content stays plaintext (only metadata encrypted here).
    assert.equal(insert.bindings[2], 'c')
  })

  test('search decrypts the O(limit) returned rows under encryptContent', async ({ assert }) => {
    const env = fakeVectorEnv({
      dimension: 8,
      encryptContent: true,
      cipher: fakeContentCipher(),
      searchHits: [{ id: 'r1', content: 'enc:hello', metadata: { k: 'v' }, distance: 0.1 }],
    })
    const matches = await new VectorStoreService(env.deps).search(
      tenant,
      { model: 'm', vector: vec(8) },
      { limit: 8 }
    )
    assert.lengthOf(matches, 1)
    assert.equal(matches[0]!.content, 'hello', 'the sealed content is opened after the ANN scan')
  })
})

test.group('VectorStoreService — content-at-rest fail postures (Wave 5)', (group) => {
  group.each.setup(() => {
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async () => {})
    return () => __setAiGuardDispatcherForTests(undefined)
  })

  test('encryptMetadata refuses a metadata-scoped read fail-closed (not silent zero rows)', async ({
    assert,
  }) => {
    const env = fakeVectorEnv({ dimension: 8, encryptMetadata: true, cipher: fakeContentCipher() })
    const store = new VectorStoreService(env.deps)
    await assert.rejects(async () => {
      try {
        await store.search(
          tenant,
          { model: 'm', vector: vec(8) },
          { limit: 8, filter: { kind: 'metadata', match: { k: 'v' } } }
        )
      } catch (error) {
        assert.instanceOf(error, AIException)
        assert.equal((error as AIException).aiCode, 'embedding_metadata_scope_conflict')
        throw error
      }
    }, /metadata is encrypted/)
    await settle()
    assert.include(rejectedIds(), 'guard.ai_embedding_metadata_scope_conflict')
    // The refusal is BEFORE any query: nothing was scanned.
    assert.lengthOf(env.queries, 0)
  })

  test('a seal failure fails the ingest CLOSED (503) and writes no row', async ({ assert }) => {
    const failingCipher = {
      seal: async () => {
        throw new Error('KMS unreachable')
      },
      open: async (_t: string, c: string) => c,
    }
    const env = insertableEnv({ encryptContent: true, cipher: failingCipher })
    const store = new VectorStoreService(env.deps)
    await assert.rejects(async () => {
      try {
        await store.insert(tenant, 'doc-1', [chunk(vec(8, 1))])
      } catch (error) {
        assert.instanceOf(error, AIException)
        assert.equal((error as AIException).aiCode, 'embedding_seal_failed')
        assert.equal((error as AIException).httpStatus, 503)
        throw error
      }
    })
    // Fail-closed: sealing happens BEFORE the transaction, so no INSERT (and no advisory
    // lock) ever ran — plaintext never touched the encrypted column.
    assert.isFalse(env.queries.some((q) => q.sql.toLowerCase().includes('insert into')))
    assert.isFalse(env.queries.some((q) => q.sql.toLowerCase().includes('pg_advisory_xact_lock')))
  })

  test('an un-openable row is dropped fail-SAFE with the undecryptable metric (shredded corpus reads empty)', async ({
    assert,
  }) => {
    const env = fakeVectorEnv({
      dimension: 8,
      encryptContent: true,
      cipher: fakeContentCipher({ shredded: true }),
      searchHits: [{ id: 'r1', content: 'enc:hello', metadata: {}, distance: 0.1 }],
    })
    const matches = await new VectorStoreService(env.deps).search(
      tenant,
      { model: 'm', vector: vec(8) },
      { limit: 8 }
    )
    assert.lengthOf(matches, 0, 'a row whose DEK was shredded is dropped, not a 500')
    assert.deepInclude(env.metrics, {
      tenantId: tenant.id,
      name: AI_EMBEDDING_CONTENT_UNDECRYPTABLE_METRIC,
      value: 1,
    })
  })
})
