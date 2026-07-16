import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
// Pure classifier, imported from source: the chaos proof exists to confirm the
// REAL error node-postgres throws when a backend is killed mid-transaction is
// the same shape the unit test asserts synthetically.
import { isDependencyOutageError } from '../../../../src/utils/dependency_outage.js'

/**
 * The connect-phase mapping covered a backend that is down when a request
 * arrives. A backend that dies DURING a request (failover, admin
 * `pg_terminate_backend`, crash) is a different failure mode and was untested.
 * This severs a live transaction's backend with `pg_terminate_backend` and
 * proves two things: (1) the real driver error is classified as a dependency
 * outage (so `mapTenantQueryError` turns it into a clean 503, not a raw 500, and
 * the HTTP mapping itself is unit-tested), and (2) Postgres has rolled the
 * aborted transaction back, so no partial write survives.
 *
 * RED (pre-fix): no mid-transaction chaos proof existed and no classifier
 * recognised the severed-connection error.
 */
const TABLE = 'lasagna_midtx_outage_test'

function rowsOf(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : ((result as any).rows ?? result)
}

test.group('pg outage mid-transaction (chaos, integration)', (group) => {
  group.setup(async () => {
    await db.connection('public').rawQuery(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id serial PRIMARY KEY,
        marker text NOT NULL
      )
    `)
  })

  group.teardown(async () => {
    await db.connection('public').rawQuery(`DROP TABLE IF EXISTS ${TABLE}`)
  })

  group.each.setup(async () => {
    await db.connection('public').rawQuery(`TRUNCATE ${TABLE}`)
  })

  test('a backend killed mid-transaction surfaces a classified outage and rolls back', async ({
    assert,
  }) => {
    const marker = randomUUID()
    let caught: unknown

    try {
      await db.connection('public').transaction(async (trx) => {
        // The backend pid this transaction is pinned to.
        const pidRes = await trx.rawQuery('SELECT pg_backend_pid() AS pid')
        const pid = rowsOf(pidRes)[0].pid

        // An in-flight write inside the open transaction (not yet committed).
        await trx.table(TABLE).insert({ marker })

        // Sever THIS transaction's backend from a different pooled connection.
        await db.connection('public').rawQuery(`SELECT pg_terminate_backend(${pid})`)

        // The next statement on the severed connection must fail.
        await trx.rawQuery('SELECT 1')
      })
      assert.fail('the transaction should have thrown once its backend was terminated')
    } catch (err) {
      caught = err
    }

    assert.isDefined(caught, 'a mid-transaction termination must surface an error')
    assert.isTrue(
      isDependencyOutageError(caught),
      `the real severed-connection error must classify as a dependency outage; got: ${
        (caught as any)?.code ?? ''
      } ${(caught as any)?.message ?? caught}`
    )

    // The aborted transaction rolled back: a fresh connection sees no partial write.
    const after = await db.connection('public').from(TABLE).where('marker', marker)
    assert.lengthOf(after, 0, 'the in-flight INSERT must not survive the aborted transaction')
  })
})
