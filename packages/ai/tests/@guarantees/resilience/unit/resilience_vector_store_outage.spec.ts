import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import VectorStoreService, {
  type VectorStoreDeps,
  type VectorQueryClient,
} from '../../../../src/services/vector_store_service.js'
import AIException from '../../../../src/exceptions/ai_exception.js'

/**
 * Wave 1.2: every raw query in the vector store funnels through one `#exec`
 * boundary that classifies a mid-query BACKEND OUTAGE into a single typed,
 * retryable `vector_store_unavailable` (503), so a database failover or an admin
 * `pg_terminate_backend` no longer surfaces as an opaque untyped 500 that every
 * caller would have to map itself. A genuine query error (a constraint) is NOT an
 * outage and must pass straight through unchanged.
 */

const tenant = { id: 'tenant-a' } as unknown as TenantModelContract

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A store whose every raw query rejects with the given error (an outage or a real query error). */
function failingStore(error: Error): VectorStoreService {
  const client: VectorQueryClient = {
    async rawQuery() {
      throw error
    },
    async transaction(callback) {
      return callback(client)
    },
  }
  const deps: VectorStoreDeps = {
    getDriver: async () => ({
      name: 'schema-pg',
      tableLocation: () => ({
        kind: 'schema',
        schema: 'tenant_fake',
        connectionName: 'tenant_conn',
      }),
    }),
    getDb: async () => ({ connection: () => client }),
    activeScopeTenantId: () => undefined,
    dimension: 8,
  }
  return new VectorStoreService(deps)
}

test.group('resilience: the vector store classifies a backend outage', () => {
  test('a pg admin_shutdown mid-query becomes a typed retryable 503', async ({ assert }) => {
    const store = failingStore(
      coded('terminating connection due to administrator command', '57P01')
    )
    let threw: unknown
    try {
      await store.count(tenant)
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'vector_store_unavailable')
    assert.equal((threw as AIException).httpStatus, 503)
    assert.isTrue((threw as AIException).isRetryable())
  })

  test('a dropped socket during a similarity search is the same typed 503', async ({ assert }) => {
    const store = failingStore(coded('read ECONNRESET', 'ECONNRESET'))
    await assert.rejects(async () => {
      try {
        await store.search(tenant, { model: 'm', vector: [1, 2, 3, 4, 5, 6, 7, 8] }, { limit: 4 })
      } catch (error) {
        assert.instanceOf(error, AIException)
        assert.equal((error as AIException).aiCode, 'vector_store_unavailable')
        throw error
      }
    })
  })

  test('an ordinary query error (a constraint) is NOT an outage and passes through unchanged', async ({
    assert,
  }) => {
    const store = failingStore(coded('duplicate key value violates unique constraint', '23505'))
    let threw: unknown
    try {
      await store.count(tenant)
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, Error)
    assert.notInstanceOf(threw, AIException)
    assert.match((threw as Error).message, /duplicate key/)
  })
})
