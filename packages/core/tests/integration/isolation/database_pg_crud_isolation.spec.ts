import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { DatabasePgDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Cross-tenant CRUD isolation for the `database-pg` driver.
 *
 * The driver-primitives spec (tests/integration/services/database_pg_driver)
 * proves provision/connect/destroy mechanics; the schema-pg path proves
 * end-to-end isolation (cross_tenant_e2e + tenant_lifecycle). This closes the
 * remaining gap: that two provisioned tenant databases never share rows when
 * CRUD runs through each tenant's own `connect()` client.
 *
 * CREATEDB-gated, like its sibling: the fixture app runs schema-pg, so we
 * instantiate database-pg directly against the same template connection. The
 * test PG role must have CREATEDB; the suite throws (skips) otherwise.
 */
const TEST_PREFIX = 'lasagna_dpci_test_'

function fakeTenant(id: string): TenantModelContract {
  return { id, name: `db-crud-iso-${id}` } as unknown as TenantModelContract
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

async function hasCreateDb(): Promise<boolean> {
  try {
    const r = await db.rawQuery(`SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user`)
    const rows = Array.isArray(r.rows) ? r.rows : (r as any)
    return rows[0]?.rolcreatedb === true
  } catch {
    return false
  }
}

test.group('DatabasePgDriver CRUD isolation (integration)', (group) => {
  let driver: DatabasePgDriver
  const created: string[] = []

  group.setup(async () => {
    if (!(await hasCreateDb())) {
      throw new Error(
        'DatabasePgDriver CRUD-isolation tests require the test PG role to have CREATEDB'
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
      await db
        .rawQuery(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = ? AND pid <> pg_backend_pid()`,
          [`${TEST_PREFIX}${id}`]
        )
        .catch(() => {})
      await db.rawQuery(`DROP DATABASE IF EXISTS "${TEST_PREFIX}${id}"`).catch(() => {})
      await driver.disconnect({ id } as any).catch(() => {})
    }
  })

  test('each tenant database is isolated — no row crosses over', async ({ assert }) => {
    const a = fakeTenant(randomId('crud_a'))
    const b = fakeTenant(randomId('crud_b'))
    created.push(a.id, b.id)

    await driver.provision(a)
    await driver.provision(b)

    const clientA = await driver.connect(a)
    const clientB = await driver.connect(b)

    // Same table, built independently in each tenant's own database.
    await clientA.rawQuery('CREATE TABLE notes (id serial primary key, body text)')
    await clientB.rawQuery('CREATE TABLE notes (id serial primary key, body text)')

    await clientA.table('notes').insert({ body: 'from-a' })
    await clientB.table('notes').multiInsert([{ body: 'from-b-1' }, { body: 'from-b-2' }])

    const bodiesA = (await clientA.from('notes').select('body').orderBy('id', 'asc')).map(
      (r: any) => r.body
    )
    const bodiesB = (await clientB.from('notes').select('body').orderBy('id', 'asc')).map(
      (r: any) => r.body
    )

    assert.deepEqual(bodiesA, ['from-a'])
    assert.deepEqual(bodiesB, ['from-b-1', 'from-b-2'])
    // The load-bearing assertion: neither tenant's database sees the other's rows.
    assert.notInclude(bodiesA, 'from-b-1')
    assert.notInclude(bodiesB, 'from-a')

    const countA = await clientA.from('notes').count('* as total')
    assert.equal(Number(countA[0].total), 1, "tenant A's database must hold exactly its own row")
  })
})
