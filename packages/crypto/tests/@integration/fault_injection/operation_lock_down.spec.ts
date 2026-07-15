import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import CryptoService from '../../../src/services/crypto_service.js'
import WormShredLedger from '../../../src/services/worm_shred_ledger.js'
import { CRYPTO_WRAPPED_DEKS_TABLE } from '../../../src/constants.js'
import {
  addTenantSchema,
  centralConn,
  createWormLedger,
  dropTenantSchema,
  dropWormLedger,
  harnessAs,
  probePg,
  realWormWriter,
  rowsOfResult,
  tenant,
  type TenantSchema,
} from '../../helpers/real_crypto_pg.js'
import { erasable } from '../../helpers/crypto_shred_fakes.js'

/**
 * Fault-injection tier: the coordination layer (the per-tenant Redis operation lock)
 * is down, so nothing serializes provision/shred. The lock is defense-in-depth, not
 * the guarantee: `withCryptoOperationLock` fails open when Redis is unreachable, and
 * the real singularity guarantees are the DB partial `UNIQUE (subject_id, category)
 * WHERE shredded_at IS NULL` and the authoritative `shredLive()` delete count. This
 * proves both against real Postgres by wiring no lock (the exact behaviour of a Redis
 * outage) and racing two writers:
 *
 *   1. two concurrent first-writes to one `(subject × category)` still leave exactly
 *      one live DEK (the partial UNIQUE refuses the second insert), never a split key;
 *   2. two concurrent shreds still destroy the DEK exactly once and write exactly one
 *      COMMITTED marker (the authoritative `shredLive()` return is the backstop; a
 *      lost race is a detectable PENDING orphan, never a double audit).
 *
 * The resilience-tier `resilience_shred_concurrent_race` proves the same authority
 * with an in-memory double; this proves the DB constraint itself is the backstop.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const CAT = 'identity-docs'
const TEST_KEY = 'crypto-fault-lock-down-key-000000000!'

let ready = false
let originalAppKey: string | undefined

test.group('crypto: coordination layer (operation lock) down (real Postgres)', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    originalAppKey = process.env.APP_KEY
    process.env.APP_KEY = TEST_KEY
    await createWormLedger()
    return async () => {
      await dropWormLedger()
      if (originalAppKey === undefined) delete process.env.APP_KEY
      else process.env.APP_KEY = originalAppKey
    }
  })

  test('two concurrent first-writes leave exactly one live DEK (the partial UNIQUE holds)', async ({
    assert,
  }) => {
    const T = randomUUID()
    const s = `crypto_lp_${suffix}_${T.slice(0, 8)}`
    const c = `crypto_lp_conn_${suffix}_${T.slice(0, 8)}`
    const routes: Record<string, TenantSchema> = { [T]: await addTenantSchema(s, c) }
    try {
      const { store, keyProvider } = harnessAs(T, { routes })
      // No `withLock` wired: exactly what a Redis outage degrades to (fail-open).
      const svc = new CryptoService({ keyProvider, store })

      const results = await Promise.allSettled([
        svc.encryptField(tenant(T), 'renter-1', CAT, 'value-a'),
        svc.encryptField(tenant(T), 'renter-1', CAT, 'value-b'),
      ])

      // At least one writer succeeded; the DB constraint is what kept it singular.
      assert.isAtLeast(
        results.filter((r) => r.status === 'fulfilled').length,
        1,
        'at least one concurrent provision succeeds'
      )
      const rows = rowsOfResult(
        await db
          .connection(c)
          .rawQuery(
            `SELECT count(*)::int AS n FROM ${CRYPTO_WRAPPED_DEKS_TABLE} WHERE subject_id = ? AND category = ? AND shredded_at IS NULL`,
            ['renter-1', CAT]
          )
      )
      assert.equal(
        Number(rows[0]?.n),
        1,
        'the partial UNIQUE keeps exactly one live DEK despite no coordination'
      )
    } finally {
      await dropTenantSchema(s, c)
    }
  }).skip(() => !ready, 'postgres not available; runs in CI')

  test('two concurrent shreds destroy the DEK once and write exactly one COMMITTED', async ({
    assert,
  }) => {
    const T = randomUUID()
    const s = `crypto_ls_${suffix}_${T.slice(0, 8)}`
    const c = `crypto_ls_conn_${suffix}_${T.slice(0, 8)}`
    const routes: Record<string, TenantSchema> = { [T]: await addTenantSchema(s, c) }
    try {
      const { store, keyProvider } = harnessAs(T, { routes })
      const svc = new CryptoService({
        keyProvider,
        store,
        erasabilityResolver: erasable(),
        ledger: new WormShredLedger(realWormWriter(T)),
      })
      await svc.encryptField(tenant(T), 'renter-1', CAT, 'a-passport-number')

      const results = await Promise.allSettled([
        svc.shred(tenant(T), 'renter-1', CAT),
        svc.shred(tenant(T), 'renter-1', CAT),
      ])

      // Exactly one call actually destroyed the DEK; the other saw it already gone.
      const shredded = results.filter(
        (r) => r.status === 'fulfilled' && r.value.shredded === true
      ).length
      assert.equal(shredded, 1, 'the authoritative shredLive() destroys the DEK exactly once')
      assert.isNull(await store.findLive(tenant(T), 'renter-1', CAT), 'the DEK is tombstoned')

      // Exactly one COMMITTED marker: no double audit despite no serialization.
      const committed = rowsOfResult(
        await db
          .connection(centralConn())
          .rawQuery(
            "SELECT count(*)::int AS n FROM backoffice.worm_ledger WHERE tenant_id = ? AND action = 'crypto:shred:committed'",
            [T]
          )
      )
      assert.equal(
        Number(committed[0]?.n),
        1,
        'exactly one COMMITTED marker; a lost race is a detectable PENDING orphan, never a double audit'
      )
    } finally {
      await dropTenantSchema(s, c)
    }
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
