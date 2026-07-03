import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { randomUUID, createHash } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import VectorStoreService, {
  type VectorDb,
  type VectorStoreDeps,
} from '../../../../src/services/vector_store_service.js'
import ConversationMemoryService from '../../../../src/services/conversation_memory_service.js'

/**
 * WS-AI-8 / 1D — a property-based cross-tenant fuzz over the AI stores, mirroring
 * the kernel's isolation_cross_tenant_fuzz: N tenants, their embed + memory ops
 * interleaved under bounded concurrency in a deterministically-shuffled order, then
 * a full read-back proving each tenant sees ONLY its own rows and turns. One foreign
 * row or turn fails the run. A final deterministic tombstone check proves a turn that
 * began before a concurrent purge does not resurrect (WS-AI-9 E5) on real Redis.
 * Self-skips when pgvector/Redis are unavailable, runs in CI.
 */
const N = 6
const PER = 6
const DIM = 4
const CONCURRENCY = 25
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)

const tenants = Array.from({ length: N }, (_, i) => ({
  i,
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_fuzz_${i}_${suffix}`,
  conn: `ai_fuzz_conn_${i}_${suffix}`,
}))

let ready = false

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

function storeFor(idx: number): VectorStoreService {
  const t = tenants[idx]
  const deps: VectorStoreDeps = {
    getDriver: async () => ({
      name: 'schema-pg',
      tableLocation: () => ({ kind: 'schema', schema: t.schema, connectionName: t.conn }),
    }),
    getDb: async () => db as unknown as VectorDb,
    activeScopeTenantId: () => t.tenant.id,
    dimension: DIM,
  }
  return new VectorStoreService(deps)
}

function memoryService(): ConversationMemoryService {
  return new ConversationMemoryService({
    getRedis: () => app.container.make('redis'),
    macKey: Buffer.alloc(32, 5),
    encryptMemory: (plain) => `e:${plain}`,
    decryptMemory: (cipher) => {
      if (!cipher.startsWith('e:')) throw new Error('not ciphertext')
      return cipher.slice(2)
    },
    config: { maxTurns: 50, ttlMs: 60_000 },
  })
}

const hash64 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Deterministic mulberry32 PRNG, so the interleaving is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** In-place deterministic Fisher-Yates. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const item = items[idx++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

const query = { model: 'm', vector: [1, 0, 0, 0] }

test.group(
  'AI cross-tenant fuzz — embeddings + memory isolation (1D, real pgvector + Redis)',
  (group) => {
    const memory = memoryService()
    const memKeys = new Map<number, string>()

    group.setup(async () => {
      const primary = getConfig().centralConnectionName
      const client = db.connection(primary)
      try {
        await client.rawQuery('SELECT 1')
        await client.rawQuery('CREATE EXTENSION IF NOT EXISTS vector')
        await app.container
          .make('redis')
          .then((r) => (r as { ping: () => Promise<unknown> }).ping())
      } catch {
        ready = false
        return
      }
      ready = true

      const template = db.manager.get(primary)?.config
      for (const t of tenants) {
        await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${t.schema}"`)
        await client.rawQuery(tableDdl(t.schema))
        // Include `public` in the path so the pgvector `vector` TYPE (created there by
        // CREATE EXTENSION) resolves; isolation still holds because `ai_embeddings`
        // resolves from the tenant schema first and `public` never holds one.
        db.manager.add(t.conn, { ...template, searchPath: [t.schema, 'public'] } as never)
        memKeys.set(t.i, memory.mintSession(t.tenant.id, 'user-a').storageKey)
      }

      return async () => {
        const cleanup = db.connection(primary)
        for (const t of tenants) {
          await cleanup.rawQuery(`DROP SCHEMA IF EXISTS "${t.schema}" CASCADE`).catch(() => {})
          if (db.manager.has(t.conn)) await db.manager.release(t.conn)
          await memory.purgeTenant(t.tenant.id).catch(() => {})
        }
      }
    })

    test('interleaved embed + memory ops for N tenants never cross a tenant boundary', async ({
      assert,
    }) => {
      // Build the flat work list: PER embeds + PER memory turns per tenant.
      type Op = { kind: 'embed' | 'mem'; i: number; j: number }
      const work: Op[] = []
      for (const t of tenants) {
        for (let j = 0; j < PER; j++) {
          work.push({ kind: 'embed', i: t.i, j })
          work.push({ kind: 'mem', i: t.i, j })
        }
      }
      shuffle(work, mulberry32(0xa1_b2_c3))

      await runBounded(work, CONCURRENCY, async (op) => {
        const t = tenants[op.i]
        const tag = `t${op.i}-${op.j}`
        if (op.kind === 'embed') {
          await storeFor(op.i).insert(t.tenant, `src-${op.j}`, [
            {
              content: `doc-${tag}`,
              contentHash: hash64(tag),
              metadata: {},
              model: 'm',
              actor: null,
              embedding: [1, 0, 0, 0],
            },
          ])
        } else {
          await memory.append(t.tenant.id, memKeys.get(op.i)!, {
            user: `turn-${tag}`,
            assistant: `ans-${tag}`,
          })
        }
      })

      // Read-back: each tenant sees ONLY its own embeddings and its own memory turns.
      for (const t of tenants) {
        const rows = await storeFor(t.i).search(t.tenant, query, {
          limit: 100,
          filter: { kind: 'all' },
        })
        assert.equal(rows.length, PER, `tenant ${t.i} sees exactly its own ${PER} docs`)
        for (const r of rows) {
          assert.isTrue(
            r.content.startsWith(`doc-t${t.i}-`),
            `tenant ${t.i} saw a foreign embedding: ${r.content}`
          )
        }

        const turns = await memory.load(t.tenant.id, memKeys.get(t.i)!)
        const users = turns.filter((x) => x.role === 'user').map((x) => x.content)
        assert.equal(users.length, PER, `tenant ${t.i} sees exactly its own ${PER} turns`)
        for (const u of users) {
          assert.isTrue(
            u.startsWith(`turn-t${t.i}-`),
            `tenant ${t.i} saw a foreign memory turn: ${u}`
          )
        }
      }
    })
      .skip(() => !ready, 'pgvector/redis not available; runs in CI')
      .timeout(60000)

    test('a turn that began before a concurrent purge does not resurrect (tombstone, E5)', async ({
      assert,
    }) => {
      const t = tenants[0]
      const key = memory.mintSession(t.tenant.id, 'user-tomb').storageKey
      await memory.append(t.tenant.id, key, { user: 'pre-purge', assistant: 'a' })
      assert.lengthOf(await memory.load(t.tenant.id, key), 2)

      // The purge stamps the tombstone at "now". A late append whose request BEGAN
      // before the purge must be dropped, not resurrected.
      const startedBefore = Date.now() - 60_000
      await memory.purgeTenant(t.tenant.id)
      await memory.append(t.tenant.id, key, { user: 'in-flight', assistant: 'b' }, startedBefore)

      assert.lengthOf(
        await memory.load(t.tenant.id, key),
        0,
        'the pre-tombstone in-flight turn did not resurrect erased history'
      )
    })
      .skip(() => !ready, 'pgvector/redis not available; runs in CI')
      .timeout(60000)
  }
)
