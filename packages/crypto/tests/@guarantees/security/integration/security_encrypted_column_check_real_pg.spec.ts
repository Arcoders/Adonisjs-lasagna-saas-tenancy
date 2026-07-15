import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import {
  addTenantSchema,
  dropTenantSchema,
  probePg,
  serviceAs,
  tenant,
  type TenantSchema,
} from '../../../helpers/real_crypto_pg.js'
import { encryptedColumnCheckSql } from '../../../../src/schema/encrypted_column.js'

/**
 * The DB-level ciphertext CHECK on real Postgres: the constraint
 * `encryptedColumnCheckSql` emits is the fail-closed backstop that stops a field marked
 * encrypted from being written as cleartext, covering the write paths the model
 * hooks cannot see. A raw `db.rawQuery('INSERT ...')` here is exactly that bypass. It
 * proves both directions end-to-end:
 *   - a plaintext write is rejected by Postgres (check_violation), even via raw SQL;
 *   - NULL and both accepted prefixes (enc_v2/enc_v1) are allowed;
 *   - a real ciphertext from `CryptoService.encryptField` satisfies the constraint, so
 *     the backstop never false-rejects the legitimate encrypt path.
 * Self-skips when Postgres is unreachable (local), runs in CI.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const schema = `crypto_check_${suffix}`
const conn = `crypto_check_conn_${suffix}`
const TABLE = 'renters'
const COL = 'passport_number'
const CAT = 'identity-docs'

let ready = false
let placement: TenantSchema
let T: string

/** Raw INSERT of a literal value into the guarded column, on the tenant connection. */
async function insertValue(value: string | null): Promise<void> {
  const client = db.connection(conn)
  if (value === null) {
    await client.rawQuery(`INSERT INTO ${TABLE} (id, ${COL}) VALUES (gen_random_uuid(), NULL)`)
  } else {
    await client.rawQuery(`INSERT INTO ${TABLE} (id, ${COL}) VALUES (gen_random_uuid(), ?)`, [
      value,
    ])
  }
}

test.group('crypto encrypted-column CHECK on real Postgres (write backstop)', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    T = randomUUID()
    placement = await addTenantSchema(schema, conn)
    // A host-style model table with the guarded encrypted column, plus the CHECK the
    // helper emits (applied via raw SQL, exactly as a host migration would).
    const client = db.connection(conn)
    await client.rawQuery(`CREATE TABLE ${TABLE} (id uuid PRIMARY KEY, ${COL} text)`)
    await client.rawQuery(encryptedColumnCheckSql(TABLE, COL))
    return async () => {
      await dropTenantSchema(schema, conn)
    }
  })

  group.each.setup(async () => {
    if (!ready) return
    await db.connection(conn).rawQuery(`DELETE FROM ${TABLE}`)
  })

  const skipUnlessReady = () => !ready
  const SKIP_REASON = 'postgres not available (local); runs in CI, fails loud under REQUIRE_REAL_PG'

  test('a plaintext write is rejected by the constraint (even via raw SQL)', async ({ assert }) => {
    await assert.rejects(() => insertValue('AB1234567'))
    // The row must not exist: the INSERT failed closed.
    const res = await db.connection(conn).rawQuery(`SELECT count(*)::int AS n FROM ${TABLE}`)
    assert.equal((res.rows?.[0]?.n ?? res[0]?.n) as number, 0)
  }).skip(skipUnlessReady, SKIP_REASON)

  test('a value that merely contains a prefix mid-string is still rejected', async ({ assert }) => {
    // The CHECK anchors on the leading chars (left(col, 7)), so an injected prefix in
    // the middle does not satisfy it.
    await assert.rejects(() => insertValue('x enc_v2: not really'))
  }).skip(skipUnlessReady, SKIP_REASON)

  test('NULL and both accepted prefixes are allowed', async ({ assert }) => {
    await insertValue(null)
    await insertValue('enc_v2:kid:iv:tag:cipher')
    await insertValue('enc_v1:legacy-frame')
    const res = await db.connection(conn).rawQuery(`SELECT count(*)::int AS n FROM ${TABLE}`)
    assert.equal((res.rows?.[0]?.n ?? res[0]?.n) as number, 3)
  }).skip(skipUnlessReady, SKIP_REASON)

  test('a real CryptoService ciphertext satisfies the constraint (no false reject)', async ({
    assert,
  }) => {
    const crypto = serviceAs(T, { routes: { [T]: placement } })
    const ciphertext = await crypto.encryptField(tenant(T), 'subject-1', CAT, 'AB1234567')
    assert.match(ciphertext, /^enc_v2:/)
    // The genuine encrypt-path output writes cleanly through the guarded column.
    await insertValue(ciphertext)
    const res = await db.connection(conn).rawQuery(`SELECT count(*)::int AS n FROM ${TABLE}`)
    assert.equal((res.rows?.[0]?.n ?? res[0]?.n) as number, 1)
  }).skip(skipUnlessReady, SKIP_REASON)
})
