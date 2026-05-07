import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { DatabasePgDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Stand-alone tests against a real PostgreSQL instance.
 *
 * The fixture app is configured for `schema-pg`, so we don't activate
 * the `database-pg` driver in the registry — we instantiate it directly
 * and exercise its primitives against the same template connection.
 *
 * The role used by the test PG instance must have `CREATEDB`. Skipping
 * the suite if the privilege is missing keeps CI healthy on locked-down
 * environments.
 */

const TEST_PREFIX = 'lasagna_dpdv_test_'

function fakeTenant(id: string): TenantModelContract {
  return { id, name: `db-driver-test-${id}` } as unknown as TenantModelContract
}

async function databaseExists(name: string): Promise<boolean> {
  const result = await db.rawQuery('SELECT 1 FROM pg_database WHERE datname = ?', [name])
  return Array.isArray(result.rows) ? result.rows.length > 0 : (result as any).length > 0
}

async function hasCreateDb(): Promise<boolean> {
  try {
    const r = await db.rawQuery(
      `SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user`
    )
    const rows = Array.isArray(r.rows) ? r.rows : (r as any)
    return rows[0]?.rolcreatedb === true
  } catch {
    return false
  }
}

test.group('DatabasePgDriver (integration)', (group) => {
  let driver: DatabasePgDriver
  const created: string[] = []

  group.setup(async () => {
    if (!(await hasCreateDb())) {
      throw new Error(
        'DatabasePgDriver integration tests require the test PG role to have CREATEDB'
      )
    }
    driver = new DatabasePgDriver({
      templateConnectionName: 'tenant',
      databasePrefix: TEST_PREFIX,
    })
  })

  group.each.teardown(async () => {
    while (created.length) {
      const id = created.pop()!
      // Best-effort cleanup; ignore errors if the database was never created.
      await db
        .rawQuery(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = ? AND pid <> pg_backend_pid()`,
          [`${TEST_PREFIX}${id}`]
        )
        .catch(() => {})
      await db
        .rawQuery(`DROP DATABASE IF EXISTS "${TEST_PREFIX}${id}"`)
        .catch(() => {})
      await driver.disconnect({ id } as any).catch(() => {})
    }
  })

  test('connectionName and databaseName follow the configured prefixes', ({ assert }) => {
    assert.equal(driver.connectionName('abc'), `tenant_abc`)
    assert.equal(driver.databaseName('abc'), `${TEST_PREFIX}abc`)
  })

  test('provision creates a database and registers the connection', async ({ assert }) => {
    const id = `prov_${Math.random().toString(36).slice(2, 10)}`
    created.push(id)

    await driver.provision(fakeTenant(id))

    assert.isTrue(await databaseExists(`${TEST_PREFIX}${id}`))
    assert.isTrue(db.manager.has(`tenant_${id}`))
  })

  test('provision is idempotent — second call does not throw', async ({ assert }) => {
    const id = `idem_${Math.random().toString(36).slice(2, 10)}`
    created.push(id)

    await driver.provision(fakeTenant(id))
    await assert.doesNotReject(() => driver.provision(fakeTenant(id)))
  })

  test('connect returns a client whose current_database matches the tenant db', async ({
    assert,
  }) => {
    const id = `conn_${Math.random().toString(36).slice(2, 10)}`
    created.push(id)
    await driver.provision(fakeTenant(id))

    const client = await driver.connect(fakeTenant(id))
    const result = await client.rawQuery(`SELECT current_database() as db`)
    const rows = Array.isArray(result.rows) ? result.rows : (result as any).rows
    assert.equal(rows[0].db, `${TEST_PREFIX}${id}`)
  })

  test('destroy terminates sessions and drops the database', async ({ assert }) => {
    const id = `dest_${Math.random().toString(36).slice(2, 10)}`
    created.push(id)
    await driver.provision(fakeTenant(id))
    // Hold a session so destroy must terminate it.
    const client = await driver.connect(fakeTenant(id))
    await client.rawQuery('SELECT 1')
    assert.isTrue(await databaseExists(`${TEST_PREFIX}${id}`))

    await driver.destroy(fakeTenant(id))

    assert.isFalse(
      await databaseExists(`${TEST_PREFIX}${id}`),
      'database should be dropped after destroy'
    )
    assert.isFalse(db.manager.has(`tenant_${id}`))
  })

  test('destroy with keepData preserves the database', async ({ assert }) => {
    const id = `keep_${Math.random().toString(36).slice(2, 10)}`
    created.push(id)
    await driver.provision(fakeTenant(id))

    await driver.destroy(fakeTenant(id), { keepData: true })

    assert.isTrue(
      await databaseExists(`${TEST_PREFIX}${id}`),
      'database should be preserved with keepData'
    )
    assert.isFalse(db.manager.has(`tenant_${id}`))
  })

  test('reset drops and re-creates the database (sentinel data is wiped)', async ({
    assert,
  }) => {
    const id = `rset_${Math.random().toString(36).slice(2, 10)}`
    created.push(id)
    await driver.provision(fakeTenant(id))

    const before = await driver.connect(fakeTenant(id))
    await before.rawQuery(`CREATE TABLE sentinel (n int)`)
    await before.rawQuery(`INSERT INTO sentinel VALUES (1), (2), (3)`)

    await driver.reset(fakeTenant(id))
    const after = await driver.connect(fakeTenant(id))
    const r = await after.rawQuery(
      `SELECT to_regclass('public.sentinel') IS NOT NULL AS has_table`
    )
    const rows = Array.isArray(r.rows) ? r.rows : (r as any).rows
    assert.isFalse(rows[0].has_table, 'sentinel must be gone after reset')
  })

  test('rejects unsafe tenant ids before any DDL runs', async ({ assert }) => {
    await assert.rejects(
      () => driver.provision(fakeTenant('abc"; DROP DATABASE postgres; --')),
      /Refusing to use unsafe/
    )
    await assert.rejects(() => driver.destroy(fakeTenant('a;b')), /Refusing to use unsafe/)
  })
})
