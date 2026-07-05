import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import VectorStoreService, {
  type VectorDb,
  type VectorStoreDeps,
} from '../../../../src/services/vector_store_service.js'
import { ensureVectorExtension, tenantSearchPath } from '../../../helpers/pgvector.js'

/**
 * The I1 proof on REAL pgvector: two tenants placed in two schemas, the same
 * text embedded into both, and a search as tenant A can never surface tenant B's
 * rows. It drives the real VectorStoreService (real `<=>`, real `vector` column,
 * real ON CONFLICT), through per-tenant connections whose search_path is the
 * only thing that differs, exactly like schema-pg. Self-skips when the Postgres
 * image lacks pgvector (local `postgres:16-alpine`), runs in CI on
 * `pgvector/pgvector:pg16`.
 */
const DIM = 4
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const schemaA = `ai_vec_a_${suffix}`
const schemaB = `ai_vec_b_${suffix}`
const connA = `ai_vec_conn_a_${suffix}`
const connB = `ai_vec_conn_b_${suffix}`
const tenantA = { id: 'A' } as unknown as TenantModelContract
const tenantB = { id: 'B' } as unknown as TenantModelContract

let pgvectorReady = false

function tableDdl(schema: string): string {
  return `CREATE TABLE IF NOT EXISTS "${schema}".ai_embeddings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content text NOT NULL,
    content_hash char(64) NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    model text NOT NULL,
    dim integer NOT NULL,
    source text NOT NULL,
    actor text,
    embedding vector(${DIM}) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, content_hash)
  )`
}

/** A store whose active scope is `activeId`, routing A->schemaA, B->schemaB. */
function storeAs(activeId: string): VectorStoreService {
  const deps: VectorStoreDeps = {
    getDriver: async () => ({
      name: 'schema-pg',
      tableLocation: (t) =>
        t.id === 'A'
          ? { kind: 'schema', schema: schemaA, connectionName: connA }
          : { kind: 'schema', schema: schemaB, connectionName: connB },
    }),
    getDb: async () => db as unknown as VectorDb,
    activeScopeTenantId: () => activeId,
    dimension: DIM,
  }
  return new VectorStoreService(deps)
}

const chunk = (content: string, hash: string, embedding: number[]) => ({
  content,
  contentHash: hash,
  metadata: { note: 'x' },
  model: 'm',
  actor: null,
  embedding,
})

test.group('vector store two-tenant isolation (real pgvector)', (group) => {
  group.setup(async () => {
    const primary = getConfig().centralConnectionName
    const client = db.connection(primary)
    try {
      await ensureVectorExtension(client)
    } catch {
      pgvectorReady = false
      return
    }
    pgvectorReady = true

    const template = db.manager.get(primary)?.config
    db.manager.add(connA, { ...template, searchPath: tenantSearchPath(schemaA) } as never)
    db.manager.add(connB, { ...template, searchPath: tenantSearchPath(schemaB) } as never)

    // Create each tenant's ai_embeddings ON that tenant's connection, whose
    // search_path appends the extensions schema — so the bare `vector(N)` type
    // resolves exactly as the production per-tenant migration does.
    for (const [schema, conn] of [
      [schemaA, connA],
      [schemaB, connB],
    ] as const) {
      await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      await db.connection(conn).rawQuery(tableDdl(schema))
    }

    return async () => {
      const cleanup = db.connection(primary)
      await cleanup.rawQuery(`DROP SCHEMA IF EXISTS "${schemaA}" CASCADE`).catch(() => {})
      await cleanup.rawQuery(`DROP SCHEMA IF EXISTS "${schemaB}" CASCADE`).catch(() => {})
      if (db.manager.has(connA)) await db.manager.release(connA)
      if (db.manager.has(connB)) await db.manager.release(connB)
    }
  })

  test('a search as tenant A never returns tenant B rows, even for identical content', async ({
    assert,
  }) => {
    // Same content + same hash + same vector in BOTH tenants: isolation is
    // structural (different schemas), not because the data differs.
    const vector = [1, 0, 0, 0]
    await storeAs('A').insert(tenantA, 'doc', [chunk('secret-of-A', 'hashsame', vector)], {
      maxCount: 100,
    })
    await storeAs('B').insert(tenantB, 'doc', [chunk('secret-of-B', 'hashsame', vector)], {
      maxCount: 100,
    })

    const aHits = await storeAs('A').search(tenantA, { model: 'm', vector }, { limit: 10 })
    const bHits = await storeAs('B').search(tenantB, { model: 'm', vector }, { limit: 10 })

    assert.deepEqual(
      aHits.map((h) => h.content),
      ['secret-of-A']
    )
    assert.deepEqual(
      bHits.map((h) => h.content),
      ['secret-of-B']
    )
    // Identical content in two tenants lands on disjoint rows (different ids).
    assert.notEqual(aHits[0].id, bHits[0].id)
    assert.equal(await storeAs('A').count(tenantA), 1)
  }).skip(() => !pgvectorReady, 'pgvector not available (local postgres:16-alpine); runs in CI')

  test('re-ingesting identical (source, content_hash) is idempotent, not a double insert', async ({
    assert,
  }) => {
    const vector = [0, 1, 0, 0]
    const first = await storeAs('A').insert(tenantA, 'dupe', [chunk('once', 'dupehash', vector)], {
      maxCount: 100,
    })
    const again = await storeAs('A').insert(tenantA, 'dupe', [chunk('once', 'dupehash', vector)], {
      maxCount: 100,
    })
    assert.equal(first.inserted, 1)
    assert.equal(again.inserted, 0)
    assert.deepEqual(first.ids, again.ids)
  }).skip(() => !pgvectorReady, 'pgvector not available (local postgres:16-alpine); runs in CI')

  test('the embeddingCount cap bites atomically at the plan limit (#18)', async ({ assert }) => {
    const store = storeAs('A')
    // Earlier tests in this group seeded tenant A's shared table, and the cap counts
    // existing rows — reset to a known-empty table so the 2/2 bite is exact.
    await db.connection(connA).rawQuery('TRUNCATE ai_embeddings')
    await store.insert(tenantA, 'capdoc', [chunk('a', 'caphash1', [1, 1, 0, 0])], { maxCount: 2 })
    await store.insert(tenantA, 'capdoc', [chunk('b', 'caphash2', [0, 0, 1, 1])], { maxCount: 2 })
    // Now at 2/2; a third must be refused before the write.
    await assert.rejects(
      () =>
        store.insert(tenantA, 'capdoc', [chunk('c', 'caphash3', [1, 0, 1, 0])], { maxCount: 2 }),
      /plan limit embeddingCount/
    )
  }).skip(() => !pgvectorReady, 'pgvector not available (local postgres:16-alpine); runs in CI')
})
