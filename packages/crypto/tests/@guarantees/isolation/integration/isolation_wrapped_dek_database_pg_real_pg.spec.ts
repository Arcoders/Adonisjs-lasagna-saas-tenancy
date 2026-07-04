import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import {
  addTenantDatabase,
  databaseServiceAs,
  dropTenantDatabase,
  hasCreateDb,
  probePg,
  rowsOfResult,
  tenant,
  type TenantDatabase,
} from '../../../helpers/real_crypto_pg.js'

/**
 * The database-pg placement on REAL Postgres: each tenant owns a separate DATABASE
 * (not just a schema). The store's `case 'database'` resolves the tenant's own
 * connection and runs the bare-name SQL there, so isolation is structural — a DEK in
 * tenant A's database is physically absent from tenant B's. This exercises the branch
 * end-to-end against two real databases. Gated on the PG role having CREATEDB (so it
 * self-skips locally when it cannot, and runs in CI where the role can).
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
const A = randomUUID()
const B = randomUUID()
const dbA = `crypto_dbpg_a_${suffix}`
const dbB = `crypto_dbpg_b_${suffix}`
const connA = `crypto_dbpg_conn_a_${suffix}`
const connB = `crypto_dbpg_conn_b_${suffix}`
const CAT = 'identity-docs'

let ready = false
let routes: Record<string, TenantDatabase> = {}

async function countIn(conn: string): Promise<number> {
  const res = await db
    .connection(conn)
    .rawQuery(`SELECT count(*)::int AS n FROM crypto_wrapped_deks`)
  return Number(rowsOfResult(res)[0].n)
}

test.group('crypto wrapped-DEK database-pg placement (real pg)', (group) => {
  group.setup(async () => {
    ready = (await probePg()) && (await hasCreateDb())
    if (!ready) return
    routes = {
      [A]: await addTenantDatabase(dbA, connA),
      [B]: await addTenantDatabase(dbB, connB),
    }
    return async () => {
      await dropTenantDatabase(dbA, connA)
      await dropTenantDatabase(dbB, connB)
    }
  })

  // The databases are provisioned once and reused, so start each test from empty.
  group.each.setup(async () => {
    if (!ready) return
    await db.connection(connA).rawQuery('TRUNCATE crypto_wrapped_deks')
    await db.connection(connB).rawQuery('TRUNCATE crypto_wrapped_deks')
  })

  test('a field round-trips through a tenant’s own database', async ({ assert }) => {
    const svcA = databaseServiceAs(A, routes)
    const ciphertext = await svcA.encryptField(tenant(A), 'renter-1', CAT, 'secret-of-A')
    assert.notEqual(ciphertext, 'secret-of-A')
    assert.equal(await svcA.decryptField(tenant(A), 'renter-1', CAT, ciphertext), 'secret-of-A')
    assert.equal(await countIn(connA), 1)
  }).skip(() => !ready, 'postgres/CREATEDB not available; runs in CI')

  test('two tenant databases are physically isolated — no DEK crosses over', async ({ assert }) => {
    const svcA = databaseServiceAs(A, routes)
    const svcB = databaseServiceAs(B, routes)

    const ciphertextA = await svcA.encryptField(tenant(A), 'shared', CAT, 'value-A')
    // B's database has no DEK row for that (subject × category): fail-closed, never plaintext.
    await assert.rejects(
      () => svcB.decryptField(tenant(B), 'shared', CAT, ciphertextA),
      /no live DEK/
    )
    // Each database holds only its own tenant's rows.
    assert.equal(await countIn(connA), 1)
    assert.equal(await countIn(connB), 0)

    // B provisions its own independent DEK for the same (subject, category).
    const ciphertextB = await svcB.encryptField(tenant(B), 'shared', CAT, 'value-B')
    assert.notEqual(ciphertextA, ciphertextB)
    assert.equal(await svcB.decryptField(tenant(B), 'shared', CAT, ciphertextB), 'value-B')
    assert.equal(await countIn(connB), 1)
  }).skip(() => !ready, 'postgres/CREATEDB not available; runs in CI')
})
