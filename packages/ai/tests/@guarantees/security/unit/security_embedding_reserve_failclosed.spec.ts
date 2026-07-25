import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { QuotaReservation } from '@adonisjs-lasagna/saas-tenancy/services'
import { SafeFetchError } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import EmbeddingIngestionService, {
  type EmbeddingIngestionDeps,
} from '../../../../src/services/embedding_ingestion_service.js'
import AIException, { httpStatusForAiCode } from '../../../../src/exceptions/ai_exception.js'
import type VectorStoreService from '../../../../src/services/vector_store_service.js'
import type { AIEmbeddingProviderContract } from '../../../../src/types/ai_embedding_contract.js'

const tenant = { id: 'tenant-a' } as unknown as TenantModelContract
const signal = () => new AbortController().signal

/** A store that fails the test loudly if it is ever reached (nothing must be written). */
const noWriteStore = {
  async insert() {
    throw new Error('the store must NOT be written when the pre-flight fails')
  },
} as unknown as VectorStoreService

const provider: AIEmbeddingProviderContract = {
  name: 'p',
  capabilities: { embedding: true },
  async verifyConfig() {},
  async embed(r) {
    return { embeddings: r.input.map(() => [1, 2, 3, 4]), model: 'm', dimension: 4, tokens: 1 }
  },
}

function deps(over: Partial<EmbeddingIngestionDeps>): EmbeddingIngestionDeps {
  return {
    store: noWriteStore,
    provider,
    quota: {
      async reserve() {
        return {} as QuotaReservation
      },
      async settle() {},
      async release() {
        return 0
      },
      async getLimit() {
        return Number.POSITIVE_INFINITY
      },
    },
    fetch: async () => new Response('ok', { status: 200 }),
    emitMetric: () => {},
    config: undefined,
    ...over,
  }
}

async function ingestCode(d: EmbeddingIngestionDeps): Promise<string> {
  try {
    await new EmbeddingIngestionService(d).ingest(
      tenant,
      { source: 's', input: ['x'], metadata: {}, actorHash: null },
      signal()
    )
    return 'no-throw'
  } catch (error) {
    if (error instanceof AIException) return error.aiCode
    throw error
  }
}

test.group('EmbeddingIngestionService: fail-closed pre-flight', () => {
  test('a reserve backend outage is a fail-closed 503, and nothing is stored', async ({
    assert,
  }) => {
    const code = await ingestCode(
      deps({
        quota: {
          async reserve() {
            throw Object.assign(new Error('redis down'), { code: 'E_DEPENDENCY_UNAVAILABLE' })
          },
          async settle() {},
          async release() {
            return 0
          },
          async getLimit() {
            return Number.POSITIVE_INFINITY
          },
        },
      })
    )
    assert.equal(code, 'rate_limit_unavailable')
    assert.equal(httpStatusForAiCode('rate_limit_unavailable'), 503)
  })

  test('an over-budget reserve is a 402 over_budget, and nothing is stored', async ({ assert }) => {
    const code = await ingestCode(
      deps({
        quota: {
          async reserve() {
            throw Object.assign(new Error('over budget'), { code: 'E_TENANT_QUOTA_EXCEEDED' })
          },
          async settle() {},
          async release() {
            return 0
          },
          async getLimit() {
            return Number.POSITIVE_INFINITY
          },
        },
      })
    )
    assert.equal(code, 'over_budget')
    assert.equal(httpStatusForAiCode('over_budget'), 402)
  })

  test('a document URL the SSRF pin blocks is a 400 doc_fetch_blocked, before any reservation', async ({
    assert,
  }) => {
    let reserved = false
    const code = await (async () => {
      try {
        await new EmbeddingIngestionService(
          deps({
            fetch: async () => {
              throw new SafeFetchError('blocked', 'link_local_metadata')
            },
            quota: {
              async reserve() {
                reserved = true
                return {} as QuotaReservation
              },
              async settle() {},
              async release() {
                return 0
              },
              async getLimit() {
                return Number.POSITIVE_INFINITY
              },
            },
          })
        ).ingest(
          tenant,
          {
            source: 's',
            input: [],
            sourceUrl: 'http://169.254.169.254/latest/meta-data',
            metadata: {},
            actorHash: null,
          },
          signal()
        )
        return 'no-throw'
      } catch (error) {
        return error instanceof AIException ? error.aiCode : 'other'
      }
    })()
    assert.equal(code, 'doc_fetch_blocked')
    assert.equal(httpStatusForAiCode('doc_fetch_blocked'), 400)
    assert.isFalse(reserved, 'the SSRF block must land before the reservation (no money spent)')
  })
})
