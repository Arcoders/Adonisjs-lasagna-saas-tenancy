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
 * The blind index enabling equality search on REAL Postgres (crypto §6.5, I5): a
 * host stores the keyed HMAC in its own index column and queries `WHERE idx = ?`.
 * This proves equality search survives encryption end-to-end, that equal plaintexts
 * share an index (the documented frequency leak, T4), and that the index SURVIVES a
 * crypto-shred (T14): after the DEK is destroyed the value is undecryptable, yet the
 * stale index still matches until the host nulls the column. Self-skips when
 * Postgres is unavailable, runs in CI.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const T = randomUUID()
const schema = `crypto_idx_${suffix}`
const conn = `crypto_idx_conn_${suffix}`
const CAT = 'identity-docs'

let ready = false
let routes: Record<string, TenantSchema> = {}

/** A host demo table: the subject id, the encrypted field, and the host-owned blind-index column. */
async function createRentersTable(): Promise<void> {
  await db
    .connection(conn)
    .rawQuery(
      `CREATE TABLE renters (id uuid PRIMARY KEY, passport_ct text NOT NULL, passport_idx text NOT NULL)`
    )
}

test.group('crypto blind-index equality query (real pg)', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    routes = { [T]: await addTenantSchema(schema, conn) }
    await createRentersTable()
    await createWormLedger()
    return async () => {
      await dropTenantSchema(schema, conn)
      await dropWormLedger()
    }
  })

  test('a WHERE on the blind index returns exactly the rows sharing the value, and they decrypt', async ({
    assert,
  }) => {
    const svc = serviceAs(T, { routes })
    const shared = 'passport-AB1234567'
    const other = 'passport-ZZ9999999'
    const renters = [
      { id: randomUUID(), passport: shared },
      { id: randomUUID(), passport: shared },
      { id: randomUUID(), passport: other },
    ]
    for (const r of renters) {
      const ciphertext = await svc.encryptField(tenant(T), r.id, CAT, r.passport)
      const index = await svc.blindIndex(tenant(T), CAT, r.passport)
      await db
        .connection(conn)
        .rawQuery(`INSERT INTO renters (id, passport_ct, passport_idx) VALUES (?, ?, ?)`, [
          r.id,
          ciphertext,
          index,
        ])
    }

    // Query by the blind index of the shared passport: both rows come back.
    const queryIndex = await svc.blindIndex(tenant(T), CAT, shared)
    const hits = rowsOfResult(
      await db
        .connection(conn)
        .rawQuery(`SELECT id, passport_ct FROM renters WHERE passport_idx = ?`, [queryIndex])
    )
    assert.lengthOf(
      hits,
      2,
      'both rows sharing the passport (the documented frequency leak, I5/T4)'
    )

    // Each hit decrypts back to the shared passport under its own subject (row id).
    for (const hit of hits) {
      const plaintext = await svc.decryptField(
        tenant(T),
        String(hit.id),
        CAT,
        String(hit.passport_ct)
      )
      assert.equal(plaintext, shared)
    }
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('the blind index survives a shred: undecryptable but still equality-matchable (T14)', async ({
    assert,
  }) => {
    const svc = serviceAs(T, { routes, withLedger: true, erasabilityResolver: erasable() })
    const subject = randomUUID()
    const passport = 'passport-SHRED-ME-77'
    const ciphertext = await svc.encryptField(tenant(T), subject, CAT, passport)
    const index = await svc.blindIndex(tenant(T), CAT, passport)
    await db
      .connection(conn)
      .rawQuery(`INSERT INTO renters (id, passport_ct, passport_idx) VALUES (?, ?, ?)`, [
        subject,
        ciphertext,
        index,
      ])

    await svc.shred(tenant(T), subject, CAT)

    // The value is now undecryptable (the DEK is destroyed) ...
    await assert.rejects(() => svc.decryptField(tenant(T), subject, CAT, ciphertext), /no live DEK/)

    // ... but the stale index still matches: the index key survived the shred, so
    // equality stays computable until the host nulls the column (T14, §6.5).
    const queryIndex = await svc.blindIndex(tenant(T), CAT, passport)
    assert.equal(queryIndex, index, 'the index key is not the DEK; it survives the shred')
    const hits = rowsOfResult(
      await db
        .connection(conn)
        .rawQuery(`SELECT id FROM renters WHERE passport_idx = ?`, [queryIndex])
    )
    assert.isAtLeast(
      hits.length,
      1,
      'the stale index still reveals equality (documented T14 residue)'
    )
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
