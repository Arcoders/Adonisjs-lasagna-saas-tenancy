import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import {
  addTenantSchema,
  createWormLedger,
  dropTenantSchema,
  dropWormLedger,
  probePg,
  rowsOfResult,
  serviceAs,
  tenant,
  type TenantSchema,
} from '../../../helpers/real_crypto_pg.js'
import { erasable } from '../../../helpers/crypto_shred_fakes.js'

/**
 * The performance guarantee: the crypto-shred is O(1) and per-write cost does not grow
 * the key store. These are the load-bearing scale properties of crypto-shredding,
 * asserted deterministically by row and operation count (never wall-clock, which
 * flakes): the cost of erasure is one key delete regardless of how much data it
 * sealed, and writing more values under a subject does not multiply keys.
 *
 * 1. Per-write cost is O(1) in the key store: encrypting one `(subject × category)`
 *    N times reuses the same live DEK, so exactly one wrapped-DEK row exists, not N.
 * 2. The shred is O(1): destroying that one DEK renders every ciphertext sealed under
 *    it inert at once, a single tombstoned row, independent of how many ciphertexts
 *    (or fields, or app rows) referenced it.
 * 3. The shred is per-subject O(1): shredding one subject touches only its row; every
 *    other subject's DEK stays live (no table-wide effect).
 *
 * Runs against the real PgWrappedDekStore and WORM ledger; self-skips without Postgres,
 * fails loud under REQUIRE_REAL_PG.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const T = randomUUID()
const schema = `crypto_perf_${suffix}`
const conn = `crypto_perf_conn_${suffix}`
const CAT = 'identity-docs'

let ready = false
let routes: Record<string, TenantSchema> = {}

/** Row counts for the tenant's wrapped-DEK table: total, live, tombstoned. */
async function deks(
  where = '',
  bindings: string[] = []
): Promise<{
  total: number
  live: number
  tombstoned: number
}> {
  const res = await db
    .connection(conn)
    .rawQuery(
      `SELECT count(*)::int AS total, ` +
        `count(*) FILTER (WHERE shredded_at IS NULL)::int AS live, ` +
        `count(*) FILTER (WHERE shredded_at IS NOT NULL)::int AS tombstoned ` +
        `FROM crypto_wrapped_deks ${where}`,
      bindings
    )
  const row = rowsOfResult(res)[0] as { total: number; live: number; tombstoned: number }
  return { total: Number(row.total), live: Number(row.live), tombstoned: Number(row.tombstoned) }
}

test.group('crypto shred is O(1): real PgWrappedDekStore and WORM ledger', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return async () => {}
    routes = { [T]: await addTenantSchema(schema, conn) }
    await createWormLedger()
    return async () => {
      await dropTenantSchema(schema, conn)
      await dropWormLedger()
    }
  })

  group.each.setup(async () => {
    if (ready) await db.connection(conn).rawQuery('TRUNCATE crypto_wrapped_deks')
  })

  test('per-write cost is O(1): N encryptions of one (subject × category) reuse a single DEK', async ({
    assert,
  }) => {
    const svc = serviceAs(T, { routes })
    const N = 25
    const ciphertexts: string[] = []
    for (let i = 0; i < N; i++) {
      ciphertexts.push(await svc.encryptField(tenant(T), 'renter-1', CAT, `value-${i}`))
    }

    // The key store holds one live DEK for the (subject × category), not N. Write
    // cost is O(1) in the number of keys, no matter how many values are sealed.
    const after = await deks()
    assert.equal(after.total, 1, 'exactly one wrapped-DEK row after N encryptions')
    assert.equal(after.live, 1)

    // Every ciphertext still decrypts under that shared DEK.
    for (let i = 0; i < N; i++) {
      assert.equal(
        await svc.decryptField(tenant(T), 'renter-1', CAT, ciphertexts[i]!),
        `value-${i}`
      )
    }
  }).skip(() => !ready, 'postgres not available; runs in CI, fails loud under REQUIRE_REAL_PG')

  test('the shred is O(1): one DEK delete makes EVERY ciphertext under it inert at once', async ({
    assert,
  }) => {
    const svc = serviceAs(T, {
      routes,
      withLedger: true,
      erasabilityResolver: erasable(),
    })
    // Seal many ciphertexts under one DEK (as many app fields/rows would).
    const N = 20
    const ciphertexts: string[] = []
    for (let i = 0; i < N; i++) {
      ciphertexts.push(await svc.encryptField(tenant(T), 'renter-2', CAT, `secret-${i}`))
    }
    assert.equal((await deks()).live, 1, 'the N ciphertexts share a single DEK')

    // One shred: a single row is tombstoned, regardless of the N ciphertexts.
    const result = await svc.shred(tenant(T), 'renter-2', CAT)
    assert.isTrue(result.shredded)
    const after = await deks()
    assert.equal(after.total, 1, 'still one row — the shred did not fan out per ciphertext')
    assert.equal(after.live, 0, 'no live DEK remains')
    assert.equal(after.tombstoned, 1, 'exactly one tombstone')

    // Every one of the N ciphertexts is now inert (the single key is gone).
    for (let i = 0; i < N; i++) {
      await assert.rejects(
        () => svc.decryptField(tenant(T), 'renter-2', CAT, ciphertexts[i]!),
        /no live DEK/
      )
    }
  }).skip(() => !ready, 'postgres not available; runs in CI, fails loud under REQUIRE_REAL_PG')

  test('the shred is per-subject O(1): shredding one subject leaves every other DEK live', async ({
    assert,
  }) => {
    const svc = serviceAs(T, {
      routes,
      withLedger: true,
      erasabilityResolver: erasable(),
    })
    // Provision independent DEKs for many subjects.
    const M = 15
    for (let i = 0; i < M; i++) {
      await svc.encryptField(tenant(T), `subject-${i}`, CAT, `v-${i}`)
    }
    assert.equal((await deks()).live, M, 'one live DEK per subject')

    // Shred exactly one subject: only its row is affected; the rest stay live.
    await svc.shred(tenant(T), 'subject-7', CAT)
    const after = await deks()
    assert.equal(after.live, M - 1, 'every other subject keeps its live DEK')
    assert.equal(after.tombstoned, 1, 'only the shredded subject is tombstoned')
    assert.equal(
      (await deks('WHERE subject_id = ? AND shredded_at IS NULL', ['subject-7'])).total,
      0,
      'the shredded subject has no live DEK'
    )
    assert.equal(
      (await deks('WHERE subject_id = ? AND shredded_at IS NULL', ['subject-8'])).total,
      1,
      'a neighbour subject is untouched'
    )
  }).skip(() => !ready, 'postgres not available; runs in CI, fails loud under REQUIRE_REAL_PG')
})
