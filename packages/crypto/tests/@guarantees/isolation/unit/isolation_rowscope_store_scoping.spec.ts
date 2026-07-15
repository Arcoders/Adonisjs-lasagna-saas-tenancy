import { test } from '@japa/runner'
import PgWrappedDekStore, {
  type CryptoDb,
  type CryptoQueryClient,
  type CryptoStoreDriver,
} from '../../../../src/services/pg_wrapped_dek_store.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Unit-level proof of the `PgWrappedDekStore` placement scoping, with a recording
 * client (no Postgres). It pins the three shapes the real SQL takes:
 *
 *   - schema/database/connection: no `tenant_id` predicate (the connection is the
 *     boundary), a single `rawQuery`, no transaction.
 *   - rowscope, rls off: an `AND tenant_id = ?` predicate is always appended and the
 *     scope column is stamped on INSERT, in a single `rawQuery`, no transaction.
 *   - rowscope, rls on: the query runs inside a transaction that first
 *     `set_config(<guc>, <tenant>, true)`s the RLS GUC, so the store's own raw SQL
 *     passes a forced policy. (The RLS *enforcement* itself is core's generic
 *     concern; here we prove the store sets the GUC.)
 */

const T = { id: 'tenant-1' } as unknown as TenantModelContract

interface Call {
  readonly sql: string
  readonly bindings: readonly unknown[]
}

/** A CryptoQueryClient that records every query and models a transaction. */
class RecordingClient implements CryptoQueryClient {
  readonly calls: Call[] = []
  txCount = 0

  async rawQuery(sql: string, bindings: readonly unknown[] = []): Promise<unknown> {
    this.calls.push({ sql, bindings })
    return { rows: [{ id: 'row-1' }] }
  }

  async transaction<R>(callback: (trx: CryptoQueryClient) => Promise<R>): Promise<R> {
    this.txCount++
    // The transaction shares the same recorder, so `calls` is the in-order log of
    // set_config then the scoped query.
    return callback(this)
  }
}

function dbOf(client: CryptoQueryClient): CryptoDb {
  return { connection: () => client }
}

function driverReturning(
  location: ReturnType<CryptoStoreDriver['tableLocation']>
): CryptoStoreDriver {
  return { name: 'test', tableLocation: () => location }
}

function storeWith(client: CryptoQueryClient, driver: CryptoStoreDriver) {
  return new PgWrappedDekStore({
    getDriver: async () => driver,
    getDb: async () => dbOf(client),
    activeScopeTenantId: () => 'tenant-1',
  })
}

const SCHEMA_LOC = { kind: 'schema', schema: 's', connectionName: 'c' } as const
const ROWSCOPE_LOC = {
  kind: 'rowscope',
  scopeColumn: 'tenant_id',
  rls: false,
  connectionName: 'central',
} as const
const ROWSCOPE_RLS_LOC = {
  kind: 'rowscope',
  scopeColumn: 'tenant_id',
  rls: true,
  rlsGuc: 'app.tenant_id',
  connectionName: 'central',
} as const

test.group('isolation: rowscope store scoping (unit)', () => {
  test('schema placement: no tenant_id predicate, no transaction', async ({ assert }) => {
    const client = new RecordingClient()
    const store = storeWith(client, driverReturning(SCHEMA_LOC))
    await store.findLive(T, 'subject-1', 'identity-docs')

    assert.equal(client.txCount, 0)
    assert.lengthOf(client.calls, 1)
    assert.notInclude(client.calls[0].sql, 'tenant_id')
    assert.deepEqual(client.calls[0].bindings, ['subject-1', 'identity-docs'])
  })

  test('rowscope (rls off): appends AND tenant_id = ?, no transaction', async ({ assert }) => {
    const client = new RecordingClient()
    const store = storeWith(client, driverReturning(ROWSCOPE_LOC))
    await store.findLive(T, 'subject-1', 'identity-docs')

    assert.equal(client.txCount, 0)
    assert.lengthOf(client.calls, 1)
    assert.include(client.calls[0].sql, 'AND tenant_id = ?')
    // subject, category, then the tenant scope bind (append order).
    assert.deepEqual(client.calls[0].bindings, ['subject-1', 'identity-docs', 'tenant-1'])
  })

  test('rowscope (rls on): sets the GUC in a transaction before the scoped query', async ({
    assert,
  }) => {
    const client = new RecordingClient()
    const store = storeWith(client, driverReturning(ROWSCOPE_RLS_LOC))
    await store.findLive(T, 'subject-1', 'identity-docs')

    assert.equal(client.txCount, 1)
    assert.lengthOf(client.calls, 2)
    // First: set_config(guc, tenant, is_local=true), all bound.
    assert.include(client.calls[0].sql, 'set_config')
    assert.deepEqual(client.calls[0].bindings, ['app.tenant_id', 'tenant-1'])
    // Then: the scoped SELECT.
    assert.include(client.calls[1].sql, 'AND tenant_id = ?')
    assert.deepEqual(client.calls[1].bindings, ['subject-1', 'identity-docs', 'tenant-1'])
  })

  test('rowscope INSERT stamps the scope column + value', async ({ assert }) => {
    const client = new RecordingClient()
    const store = storeWith(client, driverReturning(ROWSCOPE_LOC))
    await store.insert(T, {
      subjectId: 'subject-1',
      category: 'identity-docs',
      wrappedDek: 'enc_v2:...',
      kekId: 'env-abc',
    })

    assert.lengthOf(client.calls, 1)
    const { sql, bindings } = client.calls[0]
    assert.match(sql, /INSERT INTO .*\(subject_id, category, wrapped_dek, kek_id, tenant_id\)/)
    assert.include(sql, '(?, ?, ?, ?, ?)')
    assert.deepEqual(bindings, ['subject-1', 'identity-docs', 'enc_v2:...', 'env-abc', 'tenant-1'])
  })

  test('rowscope listLive: scope predicate + keyset cursor bind order', async ({ assert }) => {
    const client = new RecordingClient()
    const store = storeWith(client, driverReturning(ROWSCOPE_LOC))
    await store.listLive(T, { afterId: 'cursor-9', limit: 100 })

    assert.lengthOf(client.calls, 1)
    const { sql, bindings } = client.calls[0]
    assert.include(sql, 'id > ?')
    assert.include(sql, 'tenant_id = ?')
    // cursor, tenant scope, then limit.
    assert.deepEqual(bindings, ['cursor-9', 'tenant-1', 100])
  })
})
