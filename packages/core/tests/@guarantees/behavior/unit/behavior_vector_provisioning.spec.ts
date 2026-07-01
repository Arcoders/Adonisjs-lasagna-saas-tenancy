import { test } from '@japa/runner'
import {
  provisionVectorExtension,
  PGVECTOR_EXTENSION,
} from '../../../../src/services/isolation/vector_provisioning.js'
import { setupTestConfig } from '../../../helpers/config.js'

/**
 * Unit coverage for the pgvector provisioning dispatch (SEAM-5). The active
 * driver, Lucid db, and tenant repo are injected as fakes, so this pins the
 * placement decision (skip on sqlite, once-central on schema/rowscope, per
 * database on database-pg), the dry-run contract (no DDL issued), and the
 * privileged-connection cloning for the per-database path. The real
 * `CREATE EXTENSION` against PostgreSQL is exercised in the integration tier.
 */
function fakeDb() {
  const calls = { rawQuery: [] as string[], added: [] as string[], released: [] as string[] }
  const registered = new Map<string, any>([
    ['central', { config: { connection: { database: 'app' }, searchPath: ['public'] } }],
  ])
  const db = {
    connection: (name: string) => ({
      rawQuery: async (sql: string) => {
        calls.rawQuery.push(`${name}:${sql.trim()}`)
        return { rows: [] }
      },
    }),
    manager: {
      get: (name: string) => registered.get(name),
      has: (name: string) => registered.has(name),
      add: (name: string, config: any) => {
        registered.set(name, { config })
        calls.added.push(name)
      },
      release: async (name: string) => {
        registered.delete(name)
        calls.released.push(name)
      },
    },
  }
  return { db, calls, registered }
}

const driverOf =
  (name: string, extra: Record<string, unknown> = {}) =>
  async () =>
    ({ name, ...extra }) as any

const repoOf = (tenants: Array<{ id: string }>) => async () =>
  ({
    all: async () => tenants,
    whereIn: async (ids: string[]) => tenants.filter((t) => ids.includes(t.id)),
  }) as any

test.group('provisionVectorExtension — dispatch by driver', (group) => {
  // Pin the provisioning connection name so the fake db manager can register it.
  group.each.setup(() => setupTestConfig({ centralConnectionName: 'central' }))

  test('skips entirely on sqlite-memory (pgvector is not applicable)', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const summary = await provisionVectorExtension(
      {},
      { getDriver: driverOf('sqlite-memory'), getDb: async () => db }
    )
    assert.equal(summary.scope, 'skipped')
    assert.equal(summary.provisioned, 0)
    assert.lengthOf(calls.rawQuery, 0)
  })

  test('provisions once on the shared connection for schema-pg', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const summary = await provisionVectorExtension(
      {},
      { getDriver: driverOf('schema-pg'), getDb: async () => db }
    )
    assert.equal(summary.scope, 'central')
    assert.equal(summary.provisioned, 1)
    assert.lengthOf(calls.rawQuery, 1)
    assert.include(calls.rawQuery[0], `CREATE EXTENSION IF NOT EXISTS ${PGVECTOR_EXTENSION}`)
    assert.include(calls.rawQuery[0], 'central:', 'runs on the provision (central) connection')
  })

  test('rowscope-pg is also a single shared-database provision', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const summary = await provisionVectorExtension(
      {},
      { getDriver: driverOf('rowscope-pg'), getDb: async () => db }
    )
    assert.equal(summary.scope, 'central')
    assert.lengthOf(calls.rawQuery, 1)
  })

  test('a dry run issues no DDL', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const summary = await provisionVectorExtension(
      { dryRun: true },
      { getDriver: driverOf('schema-pg'), getDb: async () => db }
    )
    assert.isTrue(summary.dryRun)
    assert.equal(summary.provisioned, 1)
    assert.lengthOf(calls.rawQuery, 0, 'dry run must not touch the database')
  })

  test('provisions each tenant database for database-pg, cloning the privileged connection', async ({
    assert,
  }) => {
    const { db, calls } = fakeDb()
    const driver = driverOf('database-pg', {
      databaseName: (t: { id: string }) => `tenant_${t.id}`,
    })
    const summary = await provisionVectorExtension(
      {},
      { getDriver: driver, getDb: async () => db, getRepo: repoOf([{ id: 'a' }, { id: 'b' }]) }
    )
    assert.equal(summary.scope, 'per-database')
    assert.equal(summary.provisioned, 2)
    assert.equal(summary.failed, 0)
    // one throwaway connection registered + released per tenant database
    assert.lengthOf(calls.added, 2)
    assert.isTrue(calls.added.every((n) => n.startsWith('__vector_provision_')))
    assert.isTrue(
      calls.added.some((n) => n.includes('tenant_a')) &&
        calls.added.some((n) => n.includes('tenant_b'))
    )
    assert.deepEqual(calls.released, calls.added, 'every throwaway connection is released')
    assert.lengthOf(calls.rawQuery, 2)
    assert.include(calls.rawQuery[0], `CREATE EXTENSION IF NOT EXISTS ${PGVECTOR_EXTENSION}`)
  })

  test('database-pg honours --tenant filtering', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const driver = driverOf('database-pg', {
      databaseName: (t: { id: string }) => `tenant_${t.id}`,
    })
    const summary = await provisionVectorExtension(
      { tenantIds: ['b'] },
      { getDriver: driver, getDb: async () => db, getRepo: repoOf([{ id: 'a' }, { id: 'b' }]) }
    )
    assert.equal(summary.provisioned, 1)
    assert.lengthOf(calls.added, 1)
    assert.include(calls.added[0], 'tenant_b')
  })

  test('database-pg dry run lists each database without cloning or DDL', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const driver = driverOf('database-pg', {
      databaseName: (t: { id: string }) => `tenant_${t.id}`,
    })
    const summary = await provisionVectorExtension(
      { dryRun: true },
      { getDriver: driver, getDb: async () => db, getRepo: repoOf([{ id: 'a' }, { id: 'b' }]) }
    )
    assert.equal(summary.provisioned, 2)
    assert.lengthOf(calls.added, 0)
    assert.lengthOf(calls.rawQuery, 0)
  })

  test('the cloned provision connection targets the tenant database and drops searchPath', async ({
    assert,
  }) => {
    const { db, registered } = fakeDb()
    const driver = driverOf('database-pg', {
      databaseName: (t: { id: string }) => `tenant_${t.id}`,
    })
    // Capture the cloned config at add time by not releasing synchronously.
    let capturedConfig: any
    const origAdd = db.manager.add
    db.manager.add = (name: string, config: any) => {
      capturedConfig = config
      origAdd(name, config)
    }
    await provisionVectorExtension(
      {},
      { getDriver: driver, getDb: async () => db, getRepo: repoOf([{ id: 'a' }]) }
    )
    assert.equal(
      capturedConfig.connection.database,
      'tenant_a',
      'database overridden to the tenant db'
    )
    assert.isUndefined(capturedConfig.searchPath, 'schema-only searchPath dropped')
    // and the throwaway connection is cleaned up
    assert.isFalse(
      [...registered.keys()].some((k) => k.startsWith('__vector_provision_')),
      'throwaway connection released'
    )
  })

  test('database-pg continues past a failing tenant and reports the failure count', async ({
    assert,
  }) => {
    const { db, calls } = fakeDb()
    const origConn = db.connection
    // The throwaway connection for tenant b fails its DDL.
    db.connection = (name: string) =>
      name.includes('tenant_b')
        ? {
            rawQuery: async () => {
              throw new Error('database unreachable')
            },
          }
        : origConn(name)
    const driver = driverOf('database-pg', {
      databaseName: (t: { id: string }) => `tenant_${t.id}`,
    })
    const summary = await provisionVectorExtension(
      {},
      { getDriver: driver, getDb: async () => db, getRepo: repoOf([{ id: 'a' }, { id: 'b' }]) }
    )
    assert.equal(summary.provisioned, 1, 'tenant a succeeded')
    assert.equal(summary.failed, 1, 'tenant b failed but did not abort the run')
    assert.lengthOf(calls.released, 2, 'both throwaway connections are still released')
  })

  test('an unknown / custom driver is skipped, not assumed central', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const summary = await provisionVectorExtension(
      {},
      { getDriver: driverOf('my-custom-driver'), getDb: async () => db }
    )
    assert.equal(summary.scope, 'skipped')
    assert.equal(summary.provisioned, 0)
    assert.lengthOf(calls.rawQuery, 0, 'no DDL guessed for an unknown storage shape')
  })

  test('a database-pg driver missing databaseName() throws a clear contract error', async ({
    assert,
  }) => {
    const { db } = fakeDb()
    await assert.rejects(
      () =>
        provisionVectorExtension(
          {},
          {
            getDriver: driverOf('database-pg'),
            getDb: async () => db,
            getRepo: repoOf([{ id: 'a' }]),
          }
        ),
      /does not expose/
    )
  })
})
