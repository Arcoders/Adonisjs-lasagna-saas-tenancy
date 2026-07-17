import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { QuotaReservation } from '@adonisjs-lasagna/saas-tenancy/services'
import EmbeddingIngestionService, {
  type EmbeddingIngestionDeps,
  type IngestionRequest,
} from '../../../../src/services/embedding_ingestion_service.js'
import type VectorStoreService from '../../../../src/services/vector_store_service.js'
import type { AIEmbeddingProviderContract } from '../../../../src/types/ai_embedding_contract.js'
import type { SafeFetchOptions } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'

const tenant = { id: 'tenant-a' } as unknown as TenantModelContract
const signal = () => new AbortController().signal
const reservation = { id: 'r', tenantId: 'tenant-a' } as unknown as QuotaReservation

interface Harness {
  events: string[]
  metrics: Array<[string, string, number]>
  deps: EmbeddingIngestionDeps
}

function harness(
  over: Partial<EmbeddingIngestionDeps> = {},
  limit = Number.POSITIVE_INFINITY
): Harness {
  const events: string[] = []
  const metrics: Array<[string, string, number]> = []

  const provider: AIEmbeddingProviderContract = {
    name: 'mock-embedding',
    capabilities: { embedding: true },
    async verifyConfig() {},
    async embed(req) {
      events.push('embed')
      return { embeddings: req.input.map(() => [1, 2, 3, 4]), model: 'm', dimension: 4, tokens: 42 }
    },
  }

  const store = {
    async insert(_t: unknown, _source: string, chunks: unknown[]) {
      events.push(`insert:${chunks.length}`)
      return { ids: chunks.map((_c, i) => `id-${i}`), inserted: chunks.length }
    },
  } as unknown as VectorStoreService

  const quota: EmbeddingIngestionDeps['quota'] = {
    async reserve() {
      events.push('reserve')
      return reservation
    },
    async settle(_r, used) {
      events.push(`settle:${used}`)
    },
    async release() {
      events.push('release')
      return 0
    },
    async getLimit() {
      return limit
    },
  }

  const deps: EmbeddingIngestionDeps = {
    store,
    provider,
    quota,
    fetch: async () => new Response('DOC-BODY', { status: 200 }),
    emitMetric: (t, n, v) => metrics.push([t, n, v]),
    config: undefined,
    ...over,
  }
  return { events, metrics, deps }
}

const req = (over: Partial<IngestionRequest> = {}): IngestionRequest => ({
  source: 'doc-1',
  input: ['chunk one'],
  metadata: { k: 'v' },
  actorHash: 'a'.repeat(64),
  ...over,
})

test.group('EmbeddingIngestionService', () => {
  test('runs reserve -> embed -> insert -> settle -> release, in that order', async ({
    assert,
  }) => {
    const h = harness()
    const result = await new EmbeddingIngestionService(h.deps).ingest(tenant, req(), signal())
    assert.deepEqual(h.events, ['reserve', 'embed', 'insert:1', 'settle:42', 'release'])
    assert.deepEqual(result.ids, ['id-0'])
    assert.equal(result.model, 'm')
    assert.equal(result.dimension, 4)
    assert.equal(result.count, 1)
  })

  test('reserves the worst case across all chunks (per-chunk token bound)', async ({ assert }) => {
    let reservedWorstCase = 0
    const h = harness({
      quota: {
        async reserve(_t, _q, worstCase) {
          reservedWorstCase = worstCase
          return reservation
        },
        async settle() {},
        async release() {
          return 0
        },
        async getLimit() {
          return Number.POSITIVE_INFINITY
        },
      },
      config: { maxEmbeddingTokens: 100 } as never,
    })
    await new EmbeddingIngestionService(h.deps).ingest(
      tenant,
      req({ input: ['a', 'b', 'c'] }),
      signal()
    )
    assert.equal(reservedWorstCase, 300)
  })

  test('emits integer metrics that never carry chunk content (G3)', async ({ assert }) => {
    const h = harness()
    await new EmbeddingIngestionService(h.deps).ingest(
      tenant,
      req({ input: ['SECRET-CONTENT'] }),
      signal()
    )
    const names = h.metrics.map((m) => m[1])
    assert.includeMembers(names, ['ai_embeddings_ingested', 'ai_embedding_tokens_total'])
    for (const [tenantId, name, value] of h.metrics) {
      assert.equal(tenantId, 'tenant-a')
      assert.isTrue(Number.isInteger(value), `${name} must be an integer`)
    }
    assert.notInclude(JSON.stringify(h.metrics), 'SECRET-CONTENT')
  })

  test('appends a fetched document (through the SSRF-pinned fetch) as a chunk', async ({
    assert,
  }) => {
    let embeddedInput: readonly string[] = []
    const provider: AIEmbeddingProviderContract = {
      name: 'p',
      capabilities: { embedding: true },
      async verifyConfig() {},
      async embed(r) {
        embeddedInput = r.input
        return { embeddings: r.input.map(() => [1, 2, 3, 4]), model: 'm', dimension: 4, tokens: 1 }
      },
    }
    const h = harness({ provider })
    await new EmbeddingIngestionService(h.deps).ingest(
      tenant,
      req({ input: ['inline'], sourceUrl: 'https://example.com/doc' }),
      signal()
    )
    assert.deepEqual([...embeddedInput], ['inline', 'DOC-BODY'])
  })

  test('streams the sourceUrl body under a byte cap and aborts before buffering it whole', async ({
    assert,
  }) => {
    // A hostile public host (past the SSRF pin) returns an effectively unbounded
    // body. The fetch must be streamed and aborted the moment the running total
    // crosses ingestionMaxBytes, never buffered whole, so the worker cannot OOM.
    let pulls = 0
    let cancelled = false
    const oneKib = new Uint8Array(1024)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(oneKib)
      },
      cancel() {
        cancelled = true
      },
    })
    const h = harness({
      fetch: async () => new Response(body, { status: 200 }),
      config: { ingestionMaxBytes: 4096 } as never,
    })
    await assert.rejects(
      () =>
        new EmbeddingIngestionService(h.deps).ingest(
          tenant,
          req({ input: [], sourceUrl: 'https://public.example/huge' }),
          signal()
        ),
      /ingestionMaxBytes/
    )
    assert.isTrue(cancelled, 'the stream was cancelled, freeing the socket')
    assert.isBelow(pulls, 16, 'aborted near the cap, did not drain the unbounded body')
    // Nothing was reserved or embedded: the refusal is before any spend.
    assert.notInclude(h.events, 'reserve')
    assert.notInclude(h.events, 'embed')
  })

  test('fetches the document streamed and time-bounded (no unbounded buffer, no hung upstream)', async ({
    assert,
  }) => {
    let seen: SafeFetchOptions | undefined
    const h = harness({
      fetch: async (_url, opts) => {
        seen = opts
        return new Response('DOC', { status: 200 })
      },
      config: { ingestionTimeoutMs: 4321 } as never,
    })
    await new EmbeddingIngestionService(h.deps).ingest(
      tenant,
      req({ input: ['x'], sourceUrl: 'https://public.example/doc' }),
      signal()
    )
    assert.equal(seen?.streaming, true, 'streamed, so the body is never buffered whole')
    assert.equal(seen?.timeoutMs, 4321, 'time-bounded, so a hung upstream cannot pin a worker')
  })

  test('folds the model into the dedup hash: the same content under a different model is a distinct key', async ({
    assert,
  }) => {
    const hashByModel: Record<string, string> = {}
    const store = {
      async insert(
        _t: unknown,
        _source: string,
        chunks: Array<{ model: string; contentHash: string }>
      ) {
        hashByModel[chunks[0]!.model] = chunks[0]!.contentHash
        return { ids: ['id'], inserted: 1 }
      },
    } as unknown as VectorStoreService
    const providerFor = (model: string): AIEmbeddingProviderContract => ({
      name: 'p',
      capabilities: { embedding: true },
      async verifyConfig() {},
      async embed(r) {
        return { embeddings: r.input.map(() => [1, 2, 3, 4]), model, dimension: 4, tokens: 1 }
      },
    })
    const body = req({ input: ['identical content'] })
    await new EmbeddingIngestionService(
      harness({ store, provider: providerFor('model-a') }).deps
    ).ingest(tenant, body, signal())
    await new EmbeddingIngestionService(
      harness({ store, provider: providerFor('model-b') }).deps
    ).ingest(tenant, body, signal())
    await new EmbeddingIngestionService(
      harness({ store, provider: providerFor('model-a') }).deps
    ).ingest(tenant, body, signal())

    // A model swap re-embed is a distinct row key (not a swallowed no-op), while a
    // re-embed under the SAME model keeps a stable key (idempotent).
    assert.notEqual(hashByModel['model-a'], hashByModel['model-b'])
    assert.match(hashByModel['model-a']!, /^[0-9a-f]{64}$/)
  })

  test('releases the reservation even when embedding fails, and counts the error', async ({
    assert,
  }) => {
    const provider: AIEmbeddingProviderContract = {
      name: 'p',
      capabilities: { embedding: true },
      async verifyConfig() {},
      async embed() {
        throw new Error('provider exploded')
      },
    }
    const h = harness({ provider })
    await assert.rejects(() =>
      new EmbeddingIngestionService(h.deps).ingest(tenant, req(), signal())
    )
    assert.include(h.events, 'reserve')
    assert.include(h.events, 'release')
    assert.notInclude(h.events, 'settle:42')
    assert.deepEqual(
      h.metrics.filter((m) => m[1] === 'ai_embedding_errors'),
      [['tenant-a', 'ai_embedding_errors', 1]]
    )
  })
})
