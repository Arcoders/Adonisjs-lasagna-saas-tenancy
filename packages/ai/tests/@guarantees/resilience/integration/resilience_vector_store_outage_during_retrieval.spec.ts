import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import redis from '@adonisjs/redis/services/main'
import { randomUUID } from 'node:crypto'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import RetrievalService, {
  type RetrievalQuota,
} from '../../../../src/services/retrieval_service.js'
import type VectorStoreService from '../../../../src/services/vector_store_service.js'
import type { VectorMatch } from '../../../../src/services/vector_store_service.js'
import MockEmbeddingProvider from '../../../../src/testing/mock_embedding_provider.js'
import { AI_TOKENS_QUOTA } from '../../../../src/constants.js'

/**
 * WS-AI-8 / 1A — a vector-store outage during retrieval fails CLOSED without
 * leaking a cost reservation. The RetrievalService reserves the worst-case
 * aiTokens on REAL Redis, embeds the query, then searches; when the store search
 * throws (a dropped embeddings connection / a missing table), the read must
 * reject AND the `finally` must release the hold so a repeatedly-failing tenant
 * cannot leak reservations. The failure is a raw dependency error surfaced as a
 * 500 by the controller (NOT a coded AIException, NOT a 403); this spec asserts
 * the fail-closed contract at the service level: reject + released hold + the
 * `ai_retrieval_errors` metric, and a clean settle/release on recovery.
 *
 * Runs against the real QuotaService on real Redis (no pgvector needed: the store
 * is a double). The integration suite provides Redis.
 */
function fakeTenant(id: string): TenantModelContract {
  return { id, name: `ai-${id}` } as unknown as TenantModelContract
}

const matches: VectorMatch[] = [{ id: 'm1', content: 'nearest', metadata: {}, distance: 0.1 }]

/** A vector store whose search throws, simulating a downed embeddings connection. */
const outageStore = {
  async search(): Promise<VectorMatch[]> {
    const err = new Error('read ECONNRESET') as Error & { code?: string }
    err.code = 'ECONNRESET'
    throw err
  },
} as unknown as VectorStoreService

/** A healthy store that returns matches, for the recovery case. */
const healthyStore = {
  async search(): Promise<VectorMatch[]> {
    return matches
  },
} as unknown as VectorStoreService

async function tenantHoldCount(tenantId: string): Promise<number> {
  const holdKeys = await redis.keys(`quota:${tenantId}:*:holds`)
  let total = 0
  for (const key of holdKeys) total += await redis.zcard(key)
  return total
}

test.group('vector-store outage during retrieval fails closed, no leaked hold (1A)', (group) => {
  let quota: RetrievalQuota
  let tenantId: string
  let tenant: TenantModelContract
  let originalConfig: ReturnType<typeof getConfig>

  function build(store: VectorStoreService): {
    service: RetrievalService
    metrics: { name: string; value: number }[]
  } {
    const metrics: { name: string; value: number }[] = []
    const service = new RetrievalService({
      store,
      provider: new MockEmbeddingProvider({ dimension: 8 }),
      quota,
      emitMetric: (_tenantId, name, value) => metrics.push({ name, value }),
      config: { maxEmbeddingTokens: 20 } as never,
    })
    return { service, metrics }
  }

  group.setup(async () => {
    quota = (await app.container.make(QuotaService)) as unknown as RetrievalQuota
  })

  group.each.setup(() => {
    tenantId = randomUUID()
    tenant = fakeTenant(tenantId)
    originalConfig = getConfig()
    // A generous aiTokens budget so the reserve succeeds and the search is reached.
    setConfig({
      ...originalConfig,
      plans: {
        defaultPlan: 'p',
        definitions: { p: { limits: { [AI_TOKENS_QUOTA]: 100000 } } },
        getPlan: () => 'p',
      },
    } as never)
  })

  group.each.teardown(async () => {
    const keys = await redis.keys(`quota:${tenantId}:*`).catch(() => [])
    if (keys.length) await redis.del(...keys).catch(() => {})
    setConfig(originalConfig)
  })

  test('a store outage rejects and the reservation is released (no leaked hold)', async ({
    assert,
  }) => {
    const { service, metrics } = build(outageStore)

    let threw: unknown
    try {
      await service.retrieve(
        tenant,
        { query: 'what is the refund policy', limit: 5, scope: { kind: 'all' } },
        new AbortController().signal
      )
    } catch (err) {
      threw = err
    }

    assert.isDefined(threw, 'the outage must surface, not be swallowed as an empty result')
    assert.equal(
      metrics.filter((m) => m.name === 'ai_retrieval_errors').length,
      1,
      'the ai_retrieval_errors metric is emitted exactly once'
    )
    assert.equal(await tenantHoldCount(tenantId), 0, 'the worst-case hold was released on failure')
  })

  test('recovery: a healthy store settles and releases, leaving no hold', async ({ assert }) => {
    const { service } = build(healthyStore)

    const result = await service.retrieve(
      tenant,
      { query: 'what is the refund policy', limit: 5, scope: { kind: 'all' } },
      new AbortController().signal
    )

    assert.deepEqual(
      result.matches.map((m) => m.id),
      ['m1']
    )
    assert.equal(
      await tenantHoldCount(tenantId),
      0,
      'a successful read leaves no leaked hold either'
    )
  })
})
