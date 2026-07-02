import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { QuotaReservation } from '@adonisjs-lasagna/saas-tenancy/services'
import RetrievalService, {
  type RetrievalRequest,
  type RetrievalServiceDeps,
} from '../../../../src/services/retrieval_service.js'
import VectorStoreService from '../../../../src/services/vector_store_service.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import type { AIEmbeddingProviderContract } from '../../../../src/types/ai_embedding_contract.js'
import { fakeVectorEnv, type FakeVectorEnv } from '../../../helpers/fake_vector_db.js'

const tenant = { id: 'tenant-a' } as unknown as TenantModelContract
const signal = () => new AbortController().signal
const reservation = { id: 'r', tenantId: 'tenant-a' } as unknown as QuotaReservation

const hits = [
  { id: 'r1', content: 'nearest', metadata: { a: 1 }, distance: 0.1 },
  { id: 'r2', content: 'next', metadata: { a: 2 }, distance: 0.3 },
]

/** A finite length-8 vector matching the fake store's default dimension. */
const eightVec = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

interface Harness {
  events: string[]
  metrics: Array<[string, string, number]>
  env: FakeVectorEnv
  deps: RetrievalServiceDeps
}

function harness(over: Partial<RetrievalServiceDeps> = {}): Harness {
  const events: string[] = []
  const metrics: Array<[string, string, number]> = []
  const env = fakeVectorEnv({ dimension: 8, searchHits: hits })

  const provider: AIEmbeddingProviderContract = {
    name: 'mock-embedding',
    capabilities: { embedding: true },
    async verifyConfig() {},
    async embed(req) {
      events.push(`embed:${req.input.join('|')}:${req.model ?? 'none'}`)
      // The provider canonicalizes the model name: a request override 'req-model'
      // comes back as the effective 'eff-model', which is what the corpus rows
      // were stored under, so the search MUST filter on this, not the override.
      return { embeddings: req.input.map(() => eightVec), model: 'eff-model', dimension: 8, tokens: 7 }
    },
  }

  const quota: RetrievalServiceDeps['quota'] = {
    async reserve(_t, _q, worstCase) {
      events.push(`reserve:${worstCase}`)
      return reservation
    },
    async settle(_r, used) {
      events.push(`settle:${used}`)
    },
    async release() {
      events.push('release')
      return 0
    },
  }

  const deps: RetrievalServiceDeps = {
    store: new VectorStoreService(env.deps),
    provider,
    quota,
    emitMetric: (t, n, v) => metrics.push([t, n, v]),
    config: undefined,
    ...over,
  }
  return { events, metrics, env, deps }
}

const request = (over: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  query: 'find things',
  limit: 5,
  scope: { kind: 'all' },
  ...over,
})

test.group('RetrievalService', () => {
  test('runs reserve -> embed -> settle -> release and returns the mapped matches', async ({
    assert,
  }) => {
    const h = harness()
    const result = await new RetrievalService(h.deps).retrieve(tenant, request(), signal())

    assert.deepEqual(h.events, ['reserve:512', 'embed:find things:none', 'settle:7', 'release'])
    assert.deepEqual(result.matches, hits)
    assert.equal(result.model, 'eff-model')
    assert.equal(result.tokens, 7)
  })

  test('searches under the EFFECTIVE embed model, never the request override (model consistency)', async ({
    assert,
  }) => {
    const h = harness()
    await new RetrievalService(h.deps).retrieve(
      tenant,
      request({ model: 'req-model' }),
      signal()
    )
    // The provider saw the override...
    assert.include(h.events, 'embed:find things:req-model')
    // ...but the search filtered on the provider's effective model (bind index 1).
    assert.equal(h.env.queries[0].bindings[1], 'eff-model')
  })

  test('reserves the per-query worst case from config.maxEmbeddingTokens', async ({ assert }) => {
    const h = harness({ config: { maxEmbeddingTokens: 100 } as never })
    await new RetrievalService(h.deps).retrieve(tenant, request(), signal())
    assert.include(h.events, 'reserve:100')
  })

  test('pushes the retrievalFilter scope into the search WHERE clause', async ({ assert }) => {
    const h = harness()
    await new RetrievalService(h.deps).retrieve(
      tenant,
      request({ scope: { kind: 'sources', sources: ['doc-a'] } }),
      signal()
    )
    assert.match(h.env.queries[0].sql, /AND source IN \(\?\)/i)
    assert.include(h.env.queries[0].bindings as unknown[], 'doc-a')
  })

  test('an EMPTY sources scope returns nothing and spends nothing (no reserve, no embed, no query)', async ({
    assert,
  }) => {
    const h = harness()
    const result = await new RetrievalService(h.deps).retrieve(
      tenant,
      request({ scope: { kind: 'sources', sources: [] } }),
      signal()
    )
    assert.deepEqual(result.matches, [])
    assert.deepEqual(h.events, [], 'a scope that sees nothing never reserves or embeds')
    assert.lengthOf(h.env.queries, 0)
  })

  test('a reserve failure is fail-closed: quota exceeded -> over_budget, backend outage -> 503', async ({
    assert,
  }) => {
    const exceeded = harness({
      quota: {
        async reserve() {
          throw Object.assign(new Error('quota'), { code: 'E_TENANT_QUOTA_EXCEEDED' })
        },
        async settle() {},
        async release() {
          return 0
        },
      },
    })
    let threw: unknown
    try {
      await new RetrievalService(exceeded.deps).retrieve(tenant, request(), signal())
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'over_budget')
    assert.notInclude(exceeded.events, 'release', 'nothing to release: the reserve never succeeded')

    const outage = harness({
      quota: {
        async reserve() {
          throw new Error('redis down')
        },
        async settle() {},
        async release() {
          return 0
        },
      },
    })
    await assert.rejects(async () => {
      try {
        await new RetrievalService(outage.deps).retrieve(tenant, request(), signal())
      } catch (err) {
        assert.equal((err as AIException).aiCode, 'rate_limit_unavailable')
        throw err
      }
    })
  })

  test('releases the reservation even when the embed fails, counts the error, never settles', async ({
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
    await assert.rejects(() => new RetrievalService(h.deps).retrieve(tenant, request(), signal()))
    assert.include(h.events, 'reserve:512')
    assert.include(h.events, 'release')
    assert.isFalse(h.events.some((e) => e.startsWith('settle')))
    assert.deepEqual(
      h.metrics.filter((m) => m[1] === 'ai_retrieval_errors'),
      [['tenant-a', 'ai_retrieval_errors', 1]]
    )
  })

  test('emits integer metrics (tokens + match count) that never carry the query text (G3)', async ({
    assert,
  }) => {
    const h = harness()
    await new RetrievalService(h.deps).retrieve(
      tenant,
      request({ query: 'SECRET-QUERY-TEXT' }),
      signal()
    )
    const names = h.metrics.map((m) => m[1])
    assert.includeMembers(names, ['ai_retrieval_tokens_total', 'ai_retrieval_matches'])
    for (const [tenantId, name, value] of h.metrics) {
      assert.equal(tenantId, 'tenant-a')
      assert.isTrue(Number.isInteger(value), `${name} must be an integer`)
    }
    assert.notInclude(JSON.stringify(h.metrics), 'SECRET-QUERY-TEXT')
  })
})
