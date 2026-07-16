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
 * The retrieval proof on REAL pgvector: the retrievalFilter document ACL
 * narrows a search WITHIN a tenant (by provenance source and by jsonb
 * metadata), and never widens it. And it composes with tenant isolation: a scoped search as
 * tenant A can never surface tenant B's rows, even for a source key that exists
 * in both. Drives the real `<=>`, real `IN (...)` and real `@>` on per-tenant
 * schemas. Self-skips when the Postgres image lacks pgvector (local
 * `postgres:16-alpine`), runs in CI on `pgvector/pgvector:pg16`.
 */
const DIM = 4
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const schemaA = `ai_rag_a_${suffix}`
const schemaB = `ai_rag_b_${suffix}`
const connA = `ai_rag_conn_a_${suffix}`
const connB = `ai_rag_conn_b_${suffix}`
const tenantA = { id: 'A' } as unknown as TenantModelContract
const tenantB = { id: 'B' } as unknown as TenantModelContract
const query = { model: 'm', vector: [1, 0, 0, 0] }

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

const chunk = (content: string, hash: string, metadata: Record<string, unknown>) => ({
  content,
  contentHash: hash,
  metadata,
  model: 'm',
  actor: null,
  embedding: [1, 0, 0, 0],
})

const skip = () => !pgvectorReady

test.group('RAG retrieval two-tenant + filter isolation (real pgvector)', (group) => {
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
    // search_path appends the extensions schema, so the bare `vector(N)` type
    // resolves exactly as the production per-tenant migration does.
    for (const [schema, conn] of [
      [schemaA, connA],
      [schemaB, connB],
    ] as const) {
      await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      await db.connection(conn).rawQuery(tableDdl(schema))
    }

    // Tenant A: a public (sales) doc and an eng doc, both near the query vector.
    await storeAs('A').insert(tenantA, 'kb-public', [chunk('A public', 'ha1', { team: 'sales' })])
    await storeAs('A').insert(tenantA, 'kb-eng', [chunk('A eng', 'ha2', { team: 'eng' })])
    // Tenant B: the SAME source key 'kb-eng', different content.
    await storeAs('B').insert(tenantB, 'kb-eng', [chunk('B eng', 'hb1', { team: 'eng' })])

    return async () => {
      const cleanup = db.connection(primary)
      await cleanup.rawQuery(`DROP SCHEMA IF EXISTS "${schemaA}" CASCADE`).catch(() => {})
      await cleanup.rawQuery(`DROP SCHEMA IF EXISTS "${schemaB}" CASCADE`).catch(() => {})
      if (db.manager.has(connA)) await db.manager.release(connA)
      if (db.manager.has(connB)) await db.manager.release(connB)
    }
  })

  test('a sources allow-list narrows within the tenant (and never crosses tenants)', async ({
    assert,
  }) => {
    const engOnly = await storeAs('A').search(tenantA, query, {
      limit: 10,
      filter: { kind: 'sources', sources: ['kb-eng'] },
    })
    assert.deepEqual(
      engOnly.map((h) => h.content),
      ['A eng'],
      'only the allow-listed source, and it is tenant A content, not B'
    )
  }).skip(skip, 'pgvector not available (local postgres:16-alpine); runs in CI')

  test('a jsonb metadata scope narrows to matching rows', async ({ assert }) => {
    const eng = await storeAs('A').search(tenantA, query, {
      limit: 10,
      filter: { kind: 'metadata', match: { team: 'eng' } },
    })
    assert.deepEqual(
      eng.map((h) => h.content),
      ['A eng']
    )
    const sales = await storeAs('A').search(tenantA, query, {
      limit: 10,
      filter: { kind: 'metadata', match: { team: 'sales' } },
    })
    assert.deepEqual(
      sales.map((h) => h.content),
      ['A public']
    )
  }).skip(skip, 'pgvector not available (local postgres:16-alpine); runs in CI')

  test('kind:all returns the whole tenant corpus and never the other tenant', async ({
    assert,
  }) => {
    const all = await storeAs('A').search(tenantA, query, { limit: 10, filter: { kind: 'all' } })
    assert.deepEqual(all.map((h) => h.content).sort(), ['A eng', 'A public'])
    assert.notInclude(
      all.map((h) => h.content),
      'B eng',
      'the shared source key kb-eng in schema B is invisible to a tenant-A search'
    )
  }).skip(skip, 'pgvector not available (local postgres:16-alpine); runs in CI')

  test('the SAME sources filter yields disjoint rows per tenant (I1 holds under a filter)', async ({
    assert,
  }) => {
    const filter = { kind: 'sources', sources: ['kb-eng'] } as const
    const a = await storeAs('A').search(tenantA, query, { limit: 10, filter })
    const b = await storeAs('B').search(tenantB, query, { limit: 10, filter })
    assert.deepEqual(
      a.map((h) => h.content),
      ['A eng']
    )
    assert.deepEqual(
      b.map((h) => h.content),
      ['B eng']
    )
    assert.notEqual(a[0].id, b[0].id)
  }).skip(skip, 'pgvector not available (local postgres:16-alpine); runs in CI')

  test('an empty sources allow-list returns nothing (a user who may see no documents)', async ({
    assert,
  }) => {
    const none = await storeAs('A').search(tenantA, query, {
      limit: 10,
      filter: { kind: 'sources', sources: [] },
    })
    assert.deepEqual(none, [])
  }).skip(skip, 'pgvector not available (local postgres:16-alpine); runs in CI')
})
