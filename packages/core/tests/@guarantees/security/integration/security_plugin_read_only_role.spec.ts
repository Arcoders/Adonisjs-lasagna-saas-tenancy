import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'

/**
 * S3 red-team, the real firewall: proves that the read-only Postgres role the
 * tenant adapter routes untrusted plugins to actually DENIES writes at the
 * database level — not a JS proxy. The adapter routing (untrusted → the cloned
 * read-only connection) is unit-proven in
 * security_plugin_read_only_routing.spec.ts; this proves the role that connection
 * authenticates as refuses a write even when granted INSERT/UPDATE/DELETE, because
 * it runs with `default_transaction_read_only = on`.
 *
 * Runs on the `plugin_ro` connection, which CI authenticates as that role (via
 * PLUGIN_RO_DB_USER/PLUGIN_RO_DB_PASSWORD). Self-skips when the connection
 * resolves to a WRITABLE role (the local default), and — like the rowscope RLS
 * proof — fails LOUD rather than skipping when PLUGIN_RO_DB_USER is set but the
 * role turns out writable, so the guarantee can never ship false-green.
 */

const TABLE = 'lasagna_plugin_ro_test'
const PROBE_CONN = 'plugin_ro'
let readOnly = false

function rowsOf(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : (result.rows ?? result)
}

test.group('plugin read-only role (integration)', (group) => {
  group.setup(async () => {
    const admin = db.connection('public') // privileged: DDL + seed + grants
    const probe = db.connection(PROBE_CONN) // the role the proof runs as

    const roRes = await probe.rawQuery(`show transaction_read_only`)
    readOnly = rowsOf(roRes)[0]?.transaction_read_only === 'on'

    if (!readOnly && process.env.PLUGIN_RO_DB_USER) {
      throw new Error(
        `plugin read-only proof cannot run: PLUGIN_RO_DB_USER="${process.env.PLUGIN_RO_DB_USER}" ` +
          `is set, but the "${PROBE_CONN}" connection authenticated as a WRITABLE role ` +
          `(transaction_read_only=off). The role must be created with ` +
          `ALTER ROLE ... SET default_transaction_read_only = on (see .github/workflows/ci.yml). ` +
          `Refusing to pass by skipping.`
      )
    }

    await admin.rawQuery(`DROP TABLE IF EXISTS ${TABLE}`)
    await admin.rawQuery(`CREATE TABLE ${TABLE} (id serial PRIMARY KEY, note text)`)
    await admin.table(TABLE).insert({ note: 'seed' })
    // Grant BOTH read and write, so the denial below is the read-only ROLE, not a
    // missing privilege — that is exactly the guarantee (a granted write is still
    // refused because the plugin's transactions are read-only).
    await admin.rawQuery(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO PUBLIC`)
    await admin.rawQuery(`GRANT USAGE, SELECT ON SEQUENCE ${TABLE}_id_seq TO PUBLIC`)
  })

  group.teardown(async () => {
    await db.connection('public').rawQuery(`DROP TABLE IF EXISTS ${TABLE}`)
  })

  test('reads are allowed but every write is denied by Postgres, even when granted', async ({
    assert,
  }) => {
    // Local default: the probe is a writable role, so the proof is meaningless and
    // the test HONESTLY skips (no fake `assert.isTrue(true)` that reports green).
    // CI (PLUGIN_RO_DB_USER set) would have failed loud in setup instead.
    const probe = db.connection(PROBE_CONN)

    const read = await probe.rawQuery(`SELECT count(*)::int AS n FROM ${TABLE}`)
    assert.isAbove(rowsOf(read)[0].n, 0, 'the read-only role can still SELECT')

    await assert.rejects(
      () => probe.rawQuery(`INSERT INTO ${TABLE} (note) VALUES ('x')`),
      /read-only transaction/
    )
    await assert.rejects(
      () => probe.rawQuery(`UPDATE ${TABLE} SET note = 'y'`),
      /read-only transaction/
    )
    await assert.rejects(() => probe.rawQuery(`DELETE FROM ${TABLE}`), /read-only transaction/)
  }).skip(
    () => !readOnly,
    'DB role is writable (local default) — read-only firewall not enforced, proof skipped'
  )
})
