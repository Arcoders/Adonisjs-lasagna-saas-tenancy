import { test } from '@japa/runner'
import { provisionExtension } from '../../../../src/services/isolation/vector_provisioning.js'
import { setupTestConfig } from '../../../helpers/config.js'

/**
 * The generic Postgres-extension provisioner, the engine that
 * `provisionVectorExtension` now delegates to. This pins the parts NOT already
 * covered by the pgvector spec: identifier validation (name + schema go into raw
 * DDL, so a hostile value must throw BEFORE any connection work), the no-schema
 * install shape (`CREATE EXTENSION` with no `WITH SCHEMA`), generic name/schema
 * pass-through, and the `extension` field on the summary. The real `CREATE
 * EXTENSION` against PostgreSQL is exercised in the integration tier.
 */
function fakeDb() {
  const calls = { rawQuery: [] as string[] }
  const db = {
    connection: (name: string) => ({
      rawQuery: async (sql: string) => {
        calls.rawQuery.push(`${name}:${sql.trim()}`)
        return { rows: [] }
      },
    }),
    manager: {
      get: () => ({ config: {} }),
      has: () => false,
      add: () => {},
      release: async () => {},
    },
  }
  return { db, calls }
}

const driverOf = (name: string) => async () => ({ name }) as any

test.group('provisionExtension — generic engine', (group) => {
  group.each.setup(() => setupTestConfig({ centralConnectionName: 'central' }))

  test('rejects a hostile extension name BEFORE touching the database', async ({ assert }) => {
    const { db, calls } = fakeDb()
    await assert.rejects(
      () =>
        provisionExtension(
          { name: 'vector; DROP DATABASE app' },
          {},
          { getDriver: driverOf('schema-pg'), getDb: async () => db }
        ),
      /unsafe/
    )
    assert.lengthOf(calls.rawQuery, 0, 'no DDL issued for an unsafe name')
  })

  test('rejects a hostile schema name', async ({ assert }) => {
    const { db } = fakeDb()
    await assert.rejects(
      () =>
        provisionExtension(
          { name: 'postgis', schema: 'gis"; DROP' },
          {},
          { getDriver: driverOf('schema-pg'), getDb: async () => db }
        ),
      /unsafe/
    )
  })

  test('no schema → a single CREATE EXTENSION, no CREATE SCHEMA', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const summary = await provisionExtension(
      { name: 'pg_trgm' },
      {},
      { getDriver: driverOf('schema-pg'), getDb: async () => db }
    )
    assert.equal(summary.extension, 'pg_trgm')
    assert.equal(summary.scope, 'central')
    assert.lengthOf(calls.rawQuery, 1)
    assert.include(calls.rawQuery[0], 'CREATE EXTENSION IF NOT EXISTS pg_trgm')
    assert.notInclude(calls.rawQuery[0], 'WITH SCHEMA')
  })

  test('with a schema → CREATE SCHEMA then CREATE EXTENSION … WITH SCHEMA, both identifiers used', async ({
    assert,
  }) => {
    const { db, calls } = fakeDb()
    const summary = await provisionExtension(
      { name: 'postgis', schema: 'gis' },
      {},
      { getDriver: driverOf('rowscope-pg'), getDb: async () => db }
    )
    assert.equal(summary.extension, 'postgis')
    assert.lengthOf(calls.rawQuery, 2)
    assert.include(calls.rawQuery[0], 'CREATE SCHEMA IF NOT EXISTS gis')
    assert.include(calls.rawQuery[1], 'CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA gis')
  })

  test('a dry run issues no DDL and still names the extension', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const summary = await provisionExtension(
      { name: 'postgis', schema: 'gis' },
      { dryRun: true },
      { getDriver: driverOf('schema-pg'), getDb: async () => db }
    )
    assert.isTrue(summary.dryRun)
    assert.equal(summary.extension, 'postgis')
    assert.lengthOf(calls.rawQuery, 0)
  })

  test('sqlite-memory skips (extension not applicable)', async ({ assert }) => {
    const { db, calls } = fakeDb()
    const summary = await provisionExtension(
      { name: 'pg_trgm' },
      {},
      { getDriver: driverOf('sqlite-memory'), getDb: async () => db }
    )
    assert.equal(summary.scope, 'skipped')
    assert.lengthOf(calls.rawQuery, 0)
  })
})
