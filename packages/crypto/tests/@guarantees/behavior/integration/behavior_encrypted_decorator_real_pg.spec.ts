import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { compose } from '@adonisjs/core/helpers'
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
import EncryptedRepository from '../../../../src/services/encrypted_repository.js'
import { encrypted, searchable } from '../../../../src/models/encrypted_columns.js'
import { withEncryptedFields } from '../../../../src/models/with_encrypted_fields.js'

/**
 * The `@encrypted` / `@searchable` decorator surface end-to-end on REAL Postgres
 * (crypto §6.4 Option A): a Lucid model transparently encrypts on write and decrypts
 * on read through the async model hooks, and the blind index enables an equality
 * query. This is the ergonomic surface's proof against a real DB + a real
 * CryptoService, and the fail-closed read after a shred. The decorators are applied
 * functionally (the tsx spec runner rejects a decorated `declare` field; `tsc`
 * validates the `@` sugar) — the runtime path is identical. Self-skips without PG.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const T = randomUUID()
const schema = `crypto_dec_${suffix}`
const conn = `crypto_dec_conn_${suffix}`
const CAT = 'identity-docs'

// A real Lucid model on the test connection. `compose(BaseModel, withEncryptedFields)`
// wires the async encrypt/decrypt hooks; the columns are declared via the decorators.
class Renter extends compose(BaseModel, withEncryptedFields) {
  static table = 'renters'
  declare id: string
  declare passportNumber: string | null
  declare passportIndex: string | null
}
column({ isPrimary: true })(Renter.prototype, 'id')
encrypted({ category: CAT, subject: (row) => row.id })(Renter.prototype, 'passportNumber')
searchable({ category: CAT, from: (row) => row.passportNumber })(Renter.prototype, 'passportIndex')

let ready = false
let restoreRepo: (() => void) | undefined

test.group('crypto @encrypted/@searchable decorators (real pg)', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    const routes: Record<string, TenantSchema> = { [T]: await addTenantSchema(schema, conn) }
    await createWormLedger()
    await db
      .connection(conn)
      .rawQuery(
        `CREATE TABLE renters (id uuid PRIMARY KEY, passport_number text, passport_index text)`
      )
    Renter.connection = conn

    // Bind the engine the model hooks resolve: a real CryptoService against this
    // schema, with the current tenant fixed to T (fail-closed resolver).
    const repo = new EncryptedRepository({
      crypto: serviceAs(T, { routes, withLedger: true, erasabilityResolver: erasable() }),
      resolveCurrentTenant: async () => tenant(T),
    })
    app.container.singleton(EncryptedRepository, () => repo)
    restoreRepo = () => app.container.singleton(EncryptedRepository, () => repo)

    return async () => {
      await dropTenantSchema(schema, conn)
      await dropWormLedger()
    }
  })

  test('save encrypts + indexes; the row round-trips as plaintext; the DB holds ciphertext', async ({
    assert,
  }) => {
    const renter = new Renter()
    renter.id = randomUUID()
    renter.passportNumber = 'passport-AB1234567'
    await renter.save()

    // After save the in-memory value is plaintext again (decrypt-after-write).
    assert.equal(renter.passportNumber, 'passport-AB1234567')

    // On disk it is enc_v2 ciphertext + a non-empty blind index, never plaintext.
    const raw = rowsOfResult(
      await db
        .connection(conn)
        .rawQuery(`SELECT passport_number, passport_index FROM renters WHERE id = ?`, [renter.id])
    )
    assert.isTrue(String(raw[0].passport_number).startsWith('enc_v2:'), 'ciphertext at rest')
    assert.notInclude(String(raw[0].passport_number), 'passport-AB1234567')
    assert.match(String(raw[0].passport_index), /^[0-9a-f]{64}$/)

    // A fresh load decrypts transparently.
    const loaded = await Renter.find(renter.id)
    assert.equal(loaded?.passportNumber, 'passport-AB1234567')
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('a blind-index equality query finds the row without ever storing plaintext', async ({
    assert,
  }) => {
    const renter = new Renter()
    renter.id = randomUUID()
    renter.passportNumber = 'passport-QUERY-ME-42'
    await renter.save()

    // The host computes the index via the same repo and queries its own column.
    const repo = await app.container.make(EncryptedRepository)
    const index = await repo.blindIndex(CAT, 'passport-QUERY-ME-42')
    const hits = await Renter.query({ connection: conn }).where('passport_index', index)
    assert.isAtLeast(hits.length, 1)
    assert.isTrue(hits.some((h) => h.id === renter.id))
    assert.equal(hits.find((h) => h.id === renter.id)?.passportNumber, 'passport-QUERY-ME-42')
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('after a crypto-shred, loading the row fails closed (never surfaces ciphertext)', async ({
    assert,
  }) => {
    const renter = new Renter()
    renter.id = randomUUID()
    renter.passportNumber = 'passport-SHRED-99'
    await renter.save()

    // Shred the (subject × category) DEK through the same engine.
    const repo = await app.container.make(EncryptedRepository)
    const result = await repo.shred(renter.id, CAT)
    assert.isTrue(result.shredded)

    // The row still exists, but decrypting its field on load throws (I3/I6): the
    // decorator never returns the inert ciphertext as if it were plaintext.
    await assert.rejects(() => Renter.find(renter.id), /no live DEK/)

    // The ciphertext is still physically present (the host must null the column).
    const raw = rowsOfResult(
      await db
        .connection(conn)
        .rawQuery(`SELECT passport_number FROM renters WHERE id = ?`, [renter.id])
    )
    assert.isTrue(String(raw[0].passport_number).startsWith('enc_v2:'))
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('paginate() decrypts every row (no double-decrypt throw on a mainline read)', async ({
    assert,
  }) => {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const id of ids) {
      const renter = new Renter()
      renter.id = id
      renter.passportNumber = `passport-PAGE-${id.slice(0, 4)}`
      await renter.save()
    }

    // paginate() fires after:paginate THEN after:fetch on the SAME instances; a
    // regression that decrypts twice would throw here (re-opening plaintext).
    const page = await Renter.query({ connection: conn }).whereIn('id', ids).paginate(1, 10)
    const rows = page.all()
    assert.isAtLeast(rows.length, 3)
    for (const row of rows) {
      assert.isTrue(String(row.passportNumber).startsWith('passport-PAGE-'), 'decrypted plaintext')
      assert.notInclude(String(row.passportNumber), 'enc_v2:')
    }
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('load, modify, save re-encrypts + re-indexes; the stored index tracks the new value', async ({
    assert,
  }) => {
    const id = randomUUID()
    const first = new Renter()
    first.id = id
    first.passportNumber = 'passport-OLD-1'
    await first.save()

    const repo = await app.container.make(EncryptedRepository)
    const oldIndex = await repo.blindIndex(CAT, 'passport-OLD-1')

    const loaded = await Renter.find(id)
    loaded!.passportNumber = 'passport-NEW-2'
    await loaded!.save()

    // Round-trips to the NEW plaintext, and the on-disk index moves with it.
    const reloaded = await Renter.find(id)
    assert.equal(reloaded?.passportNumber, 'passport-NEW-2')
    const raw = rowsOfResult(
      await db.connection(conn).rawQuery(`SELECT passport_index FROM renters WHERE id = ?`, [id])
    )
    const newIndex = await repo.blindIndex(CAT, 'passport-NEW-2')
    assert.equal(String(raw[0].passport_index), newIndex, 'index recomputed from the new value')
    assert.notEqual(String(raw[0].passport_index), oldIndex, 'the old index is gone')
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('fail-closed: with no active tenant scope, a save aborts and writes nothing (T5)', async ({
    assert,
  }) => {
    // Swap the engine for one that resolves no tenant.
    const noScope = new EncryptedRepository({
      crypto: serviceAs(T, { routes: { [T]: { schema, conn } } }),
      resolveCurrentTenant: async () => null,
    })
    app.container.singleton(EncryptedRepository, () => noScope)
    try {
      const renter = new Renter()
      renter.id = randomUUID()
      renter.passportNumber = 'passport-NO-SCOPE'
      await assert.rejects(() => renter.save(), /no active tenant scope/)

      // Nothing was written (the before-create hook threw before the INSERT).
      const raw = rowsOfResult(
        await db
          .connection(conn)
          .rawQuery(`SELECT count(*)::int AS n FROM renters WHERE id = ?`, [renter.id])
      )
      assert.equal(Number(raw[0].n), 0, 'no cleartext row leaked')
    } finally {
      restoreRepo?.()
    }
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
