import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { SqliteMemoryDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Storage-lifecycle coverage for the testing-only `sqlite-memory` driver.
 *
 * sqlite-memory is the driver the docs recommend for users' own test suites,
 * so its happy path must actually work: provision, connect, then CRUD, with each
 * tenant getting its own isolated in-memory database, and destroy reclaiming
 * the pages so a re-provision starts empty. The unit spec only covers naming;
 * this drives real storage.
 *
 * It lives in the integration suite because `connect()` resolves the
 * container-bound Lucid `db` service (a booted app), but it needs no
 * PostgreSQL of its own. Every query runs against in-memory SQLite. We
 * instantiate the driver directly rather than through the registry, since the
 * fixture app is configured for `schema-pg`; the sqlite driver registers its
 * own connection and is independent of the active driver.
 *
 * `better-sqlite3` is an optional peer dependency (npm does not auto-install
 * optional peers), so the suite skips gracefully when it is absent instead of
 * hard-failing, the same way the `*_real` specs skip without their backing
 * service. CI installs it explicitly so this actually runs there.
 */
// Probe via a non-literal specifier so tsc doesn't resolve the optional dep's
// types at build time (it isn't installed in the typecheck job).
const sqlitePkg = 'better-sqlite3'
const sqliteAvailable = await import(sqlitePkg).then(
  () => true,
  () => false
)

function fakeTenant(id: string): TenantModelContract {
  return { id, name: `sqlite-mem-${id}` } as unknown as TenantModelContract
}

const CREATE_NOTES = 'CREATE TABLE notes (id integer primary key, body text)'

test.group('SqliteMemoryDriver storage lifecycle (integration)', (group) => {
  const driver = new SqliteMemoryDriver()
  const provisioned: TenantModelContract[] = []

  group.each.teardown(async () => {
    while (provisioned.length) {
      const t = provisioned.pop()!
      await driver.destroy(t).catch(() => {})
    }
  })

  test('two tenants get fully isolated in-memory stores', async ({ assert }) => {
    const a = fakeTenant(randomUUID())
    const b = fakeTenant(randomUUID())
    provisioned.push(a, b)

    await driver.provision(a)
    await driver.provision(b)

    const clientA = await driver.connect(a)
    const clientB = await driver.connect(b)

    // Same table name, built independently in each tenant's database.
    await clientA.rawQuery(CREATE_NOTES)
    await clientB.rawQuery(CREATE_NOTES)

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
    // The load-bearing assertion: neither tenant sees the other's rows.
    assert.notInclude(bodiesA, 'from-b-1')
    assert.notInclude(bodiesB, 'from-a')
  }).skip(!sqliteAvailable, 'requires the optional better-sqlite3 peer dependency')

  test('destroy + re-provision starts from an empty store', async ({ assert }) => {
    const t = fakeTenant(randomUUID())
    provisioned.push(t)

    await driver.provision(t)
    const first = await driver.connect(t)
    await first.rawQuery(CREATE_NOTES)
    await first.table('notes').insert({ body: 'gone' })
    assert.lengthOf(await first.from('notes').select('body'), 1)

    await driver.destroy(t)
    await driver.provision(t)
    const second = await driver.connect(t)

    // Releasing the connection drops the in-memory database; the fresh one
    // must not retain the previous table.
    const tables = await second.from('sqlite_master').where('type', 'table').where('name', 'notes')
    assert.lengthOf(tables, 0, 'a fresh in-memory db must not retain the previous table')
  }).skip(!sqliteAvailable, 'requires the optional better-sqlite3 peer dependency')
})
