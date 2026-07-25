import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import AiProvider from '../../../../providers/ai_provider.js'
import AiComplianceService from '../../../../src/services/ai_compliance_service.js'
import ConversationMemoryService from '../../../../src/services/conversation_memory_service.js'
import VectorStoreService, {
  type VectorDb,
  type VectorStoreDeps,
} from '../../../../src/services/vector_store_service.js'
import AiIdempotencyService, {
  type AiIdempotencyScope,
  type CachedAiResponse,
} from '../../../../src/gateway/idempotency.js'
import {
  setupRealAudit,
  realWriter,
  auditRow,
  centralConn,
  rowsOfResult,
} from '../../../helpers/real_audit_pg.js'
import { ensureVectorExtension, tenantSearchPath } from '../../../helpers/pgvector.js'

/**
 * Purge-completeness on the REAL stores. After
 * `AiComplianceService.purgeTenant`, a scan of every PII store must find ZERO
 * residue (embeddings gone, memory gone, the idempotency cache epoch bumped so a
 * pre-purge cached completion is unreachable), while the immutable, non-PII audit
 * chain SURVIVES (erasure of PII must not destroy the tamper-evident record).
 * Validates the purge end to end against pgvector + Redis + Postgres. Self-skips when
 * pgvector/Redis/Postgres are unavailable, runs in CI.
 */
const DIM = 4
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const schema = `ai_purge_${suffix}`
const conn = `ai_purge_conn_${suffix}`
const tenant = { id: randomUUID() } as unknown as TenantModelContract

let ready = false

function tableDdl(): string {
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

function vectorStore(): VectorStoreService {
  const deps: VectorStoreDeps = {
    getDriver: async () => ({
      name: 'schema-pg',
      tableLocation: () => ({ kind: 'schema', schema, connectionName: conn }),
    }),
    getDb: async () => db as unknown as VectorDb,
    activeScopeTenantId: () => tenant.id,
    dimension: DIM,
  }
  return new VectorStoreService(deps)
}

function memoryService(): ConversationMemoryService {
  return new ConversationMemoryService({
    getRedis: () => app.container.make('redis'),
    macKey: Buffer.alloc(32, 5),
    encryptMemory: async (_tenantId, plain) => `e:${plain}`,
    decryptMemory: async (_tenantId, cipher) => {
      if (!cipher.startsWith('e:')) throw new Error('not ciphertext')
      return cipher.slice(2)
    },
    config: { maxTurns: 5, ttlMs: 60_000 },
  })
}

const cached: CachedAiResponse = {
  v: 1,
  frames: ['id: 1\nevent: token\ndata: real\n\n'],
  result: { tokensSettled: 3, fragments: 1, lastEventId: '1' },
}
const idemScope: AiIdempotencyScope = {
  tenantId: tenant.id,
  principal: 'user-1',
  sessionId: 's1',
  headerKey: 'retry-1e',
}

test.group('AI purge-completeness across real stores', (group) => {
  let store: VectorStoreService
  let memory: ConversationMemoryService
  let idempotency: AiIdempotencyService
  let compliance: AiComplianceService
  let memKey: string

  group.setup(async () => {
    const primary = getConfig().centralConnectionName
    const client = db.connection(primary)
    const template = db.manager.get(primary)?.config
    try {
      await client.rawQuery('SELECT 1')
      await ensureVectorExtension(client)
      await app.container.make('redis').then((r) => (r as { ping: () => Promise<unknown> }).ping())
      // Register the tenant connection (extensions schema appended) and create the
      // table ON it so the bare `vector(N)` resolves exactly like the migration.
      db.manager.add(conn, { ...template, searchPath: tenantSearchPath(schema) } as never)
      await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      await db.connection(conn).rawQuery(tableDdl())
    } catch {
      ready = false
      return async () => {}
    }
    const audit = await setupRealAudit()
    ready = audit.ready
    if (!ready) return async () => {}

    new AiProvider(app).register?.()
    idempotency = await app.container.make(AiIdempotencyService)
    store = vectorStore()
    memory = memoryService()
    compliance = new AiComplianceService({
      memory,
      vectorStore: store,
      idempotency,
      runScoped: (_t, fn) => fn(),
      embeddingsEnabled: true,
      getRedis: () => app.container.make('redis'),
    })

    return async () => {
      const cleanup = db.connection(primary)
      await cleanup.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
      if (db.manager.has(conn)) await db.manager.release(conn)
      await audit.cleanup()
    }
  })

  test('after purgeTenant every PII store is empty and the non-PII audit chain survives', async ({
    assert,
  }) => {
    // Seed all three PII stores + the immutable audit chain.
    await store.insert(tenant, 'kb-1', [
      {
        content: 'secret',
        contentHash: 'h'.repeat(64),
        metadata: {},
        model: 'm',
        actor: null,
        embedding: [1, 0, 0, 0],
      },
    ])
    const { storageKey } = memory.mintSession(tenant.id, 'user-1')
    memKey = storageKey
    await memory.append(tenant.id, memKey, { user: 'q', assistant: 'a' })
    await idempotency.save(idemScope, cached)

    const writer = realWriter(tenant.id)
    await writer.append(auditRow(tenant.id))
    await writer.append(auditRow(tenant.id))

    // Pre-conditions: everything present.
    assert.equal(await store.count(tenant), 1)
    assert.lengthOf(await memory.load(tenant.id, memKey), 2)
    assert.deepEqual(await idempotency.lookup(idemScope), cached)
    const before = await writer.verify(tenant.id)
    assert.isTrue(before.ok)
    assert.equal(before.checked, 2)

    // Erase.
    const summary = await compliance.purgeTenant(tenant)
    assert.isTrue(summary.ok, 'no purge step failed')

    // Completeness: every PII store is empty.
    assert.equal(await store.count(tenant), 0, 'embeddings erased')
    assert.lengthOf(await memory.load(tenant.id, memKey), 0, 'conversation memory erased')
    assert.isNull(
      await idempotency.lookup(idemScope),
      'the epoch bump makes the pre-purge cached completion unreachable (no GDPR resurrection)'
    )

    // The immutable, non-PII audit chain SURVIVES the purge and still verifies.
    const after = await writer.verify(tenant.id)
    assert.isTrue(after.ok, 'the audit chain still verifies after erasure')
    assert.equal(
      after.checked,
      2,
      'audit rows survive a PII purge (non-PII, tamper-evident record)'
    )
    const client = db.connection(centralConn())
    const res = await client.rawQuery(
      'SELECT count(*) AS c FROM backoffice.ai_audit_logs WHERE tenant_id = ?',
      [tenant.id]
    )
    assert.equal(Number(rowsOfResult(res)[0]!.c), 2)
  }).skip(() => !ready, 'pgvector/redis/postgres not available; runs in CI')
})
