import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import {
  addTenantSchema,
  centralConn,
  createWormLedger,
  dropTenantSchema,
  dropWormLedger,
  probePg,
  rowsOfResult,
  serviceAs,
  tenant,
  type TenantSchema,
} from '../../../helpers/real_crypto_pg.js'
import { byCategory, erasable } from '../../../helpers/crypto_shred_fakes.js'

/**
 * Crypto-shred as the O(1) erasure on real Postgres (the design's `resilience_shred_makes_
 * ciphertext_inert`): a crypto-shred tombstones the wrapped-DEK row through the real
 * store, and the field ciphertext is then undecryptable, while the two-phase audit
 * lands a PENDING then a COMMITTED row in the real `backoffice.worm_ledger`. It also
 * proves the legal-hold refusal (the DEK survives) and the re-provision after
 * a shred. Self-skips when Postgres is unavailable, runs in CI.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const T = randomUUID()
const schema = `crypto_shred_${suffix}`
const conn = `crypto_shred_conn_${suffix}`
const CONSENT = 'marketing'

let ready = false
let routes: Record<string, TenantSchema> = {}

test.group('crypto shred makes ciphertext inert (real pg + WORM ledger)', (group) => {
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

  test('a shred destroys the DEK, tombstones the row, records PENDING+COMMITTED, and the ciphertext is inert', async ({
    assert,
  }) => {
    const svc = serviceAs(T, { routes, withLedger: true, erasabilityResolver: erasable() })
    const ciphertext = await svc.encryptField(tenant(T), 'renter-1', CONSENT, 'passport-AB1234567')
    assert.equal(
      await svc.decryptField(tenant(T), 'renter-1', CONSENT, ciphertext),
      'passport-AB1234567'
    )

    const result = await svc.shred(tenant(T), 'renter-1', CONSENT)
    assert.isTrue(result.shredded, 'a live DEK was destroyed')

    // The DEK is gone: the field ciphertext is now inert.
    await assert.rejects(
      () => svc.decryptField(tenant(T), 'renter-1', CONSENT, ciphertext),
      /no live DEK/
    )

    // The wrapped-DEK row is tombstoned (shredded_at set, wrapped_dek nulled).
    const dekRows = rowsOfResult(
      await db
        .connection(conn)
        .rawQuery(
          `SELECT shredded_at, wrapped_dek FROM crypto_wrapped_deks WHERE subject_id = ? AND category = ?`,
          ['renter-1', CONSENT]
        )
    )
    assert.isNotNull(dekRows[0]?.shredded_at, 'the row is tombstoned')
    assert.isNull(dekRows[0]?.wrapped_dek, 'the only copy of the key is destroyed')

    // The two-phase audit landed a PENDING then a COMMITTED row in the WORM ledger.
    const ledger = rowsOfResult(
      await db
        .connection(centralConn())
        .rawQuery(
          `SELECT action FROM backoffice.worm_ledger WHERE tenant_id = ? ORDER BY seq ASC`,
          [T]
        )
    )
    assert.deepEqual(
      ledger.map((r) => r.action),
      ['crypto:shred:pending', 'crypto:shred:committed']
    )
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('a legal-obligation category in retention is refused; the DEK survives', async ({
    assert,
  }) => {
    // Only the consent category is erasable; a legal-obligation one is refused.
    const svc = serviceAs(T, {
      routes,
      withLedger: true,
      erasabilityResolver: byCategory([CONSENT]),
    })
    const ciphertext = await svc.encryptField(
      tenant(T),
      'renter-9',
      'rental-contract',
      'signed-contract'
    )
    await assert.rejects(
      () => svc.shred(tenant(T), 'renter-9', 'rental-contract'),
      /not erasable|legal|refus/i
    )
    // The signed contract survives and is still readable (it is evidence).
    assert.equal(
      await svc.decryptField(tenant(T), 'renter-9', 'rental-contract', ciphertext),
      'signed-contract'
    )
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('a re-provision after a shred inserts a fresh live DEK (partial unique)', async ({
    assert,
  }) => {
    const svc = serviceAs(T, { routes, withLedger: true, erasabilityResolver: erasable() })
    await svc.encryptField(tenant(T), 'renter-5', CONSENT, 'v1')
    await svc.shred(tenant(T), 'renter-5', CONSENT)

    // A later legitimate re-provision inserts a fresh live row despite the tombstone
    // (the partial UNIQUE is WHERE shredded_at IS NULL).
    const ciphertext2 = await svc.encryptField(tenant(T), 'renter-5', CONSENT, 'v2')
    assert.equal(await svc.decryptField(tenant(T), 'renter-5', CONSENT, ciphertext2), 'v2')

    const rows = rowsOfResult(
      await db
        .connection(conn)
        .rawQuery(
          `SELECT shredded_at FROM crypto_wrapped_deks WHERE subject_id = ? AND category = ? ORDER BY created_at ASC`,
          ['renter-5', CONSENT]
        )
    )
    assert.lengthOf(rows, 2, 'a tombstone plus a fresh live row')
    assert.isNotNull(rows[0]?.shredded_at, 'the first row is the tombstone')
    assert.isNull(rows[1]?.shredded_at, 'the second row is live')
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
