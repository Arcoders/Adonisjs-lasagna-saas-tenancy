import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import CryptoService from '../../../src/services/crypto_service.js'
import WormShredLedger from '../../../src/services/worm_shred_ledger.js'
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
import type { ShredLedger } from '../../../src/types/shred_ledger.js'

/**
 * Fault-injection tier: the WORM audit write drops before the irreversible delete.
 *
 * The shred is two-phase: a PENDING WORM row is appended before the tombstone, and a
 * COMMITTED marker after. The audit-before-delete order is the interlock that makes an
 * erasure impossible to run unaudited. This injects a real database fault at the
 * PENDING append (as if Postgres dropped the connection during the ledger INSERT) and
 * asserts the fail-closed posture against real Postgres: the shred aborts
 * (`shred_unaudited`) with nothing destroyed, the wrapped-DEK row is still live, and
 * its field value still decrypts. The distinct crash-after-delete mode (a detectable
 * PENDING orphan) is the resilience-tier `resilience_shred_committed_mark_fails` spec;
 * this is the crash-before-delete mode, where the erasure never happens at all.
 *
 * Injection is through the injected `ShredLedger` seam; the real store, schema, and
 * the real append-only worm_ledger table (used by the recovery case) are untouched.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const CAT = 'marketing'
const TEST_KEY = 'crypto-fault-worm-down-key-000000000!'

let ready = false
let originalAppKey: string | undefined

/** A ledger whose PENDING append drops as if Postgres died mid-INSERT. */
function pendingAppendDown(): ShredLedger {
  return {
    appendPending(): Promise<never> {
      const err = new Error('write ECONNRESET') as Error & { code?: string }
      err.code = 'ECONNRESET'
      throw err
    },
    async markCommitted(): Promise<void> {},
  }
}

test.group('crypto shred: WORM audit write drops before the delete (real Postgres)', (group) => {
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

  test('a PENDING-append failure aborts the shred with nothing destroyed, then recovers', async ({
    assert,
  }) => {
    const T = randomUUID()
    const s = `crypto_wl_${suffix}_${T.slice(0, 8)}`
    const c = `crypto_wl_conn_${suffix}_${T.slice(0, 8)}`
    const routes: Record<string, TenantSchema> = { [T]: await addTenantSchema(s, c) }
    try {
      const { store, keyProvider } = harnessAs(T, { routes })
      const ciphertext = await new CryptoService({ keyProvider, store }).encryptField(
        tenant(T),
        'renter-1',
        CAT,
        'a-marketing-email'
      )

      // The audit write drops before the delete, so the shred aborts and nothing is destroyed.
      const brokenAudit = new CryptoService({
        keyProvider,
        store,
        erasabilityResolver: erasable(),
        ledger: pendingAppendDown(),
      })
      await assert.rejects(
        () => brokenAudit.shred(tenant(T), 'renter-1', CAT),
        /PENDING append failed|nothing was destroyed/
      )

      // The DEK is untouched: the row is still live and the value still decrypts.
      assert.isNotNull(
        await store.findLive(tenant(T), 'renter-1', CAT),
        'an aborted shred must leave the live DEK row intact'
      )
      assert.equal(
        await new CryptoService({ keyProvider, store }).decryptField(
          tenant(T),
          'renter-1',
          CAT,
          ciphertext
        ),
        'a-marketing-email',
        'nothing was destroyed, so the value still decrypts'
      )
      // No ledger rows were written for this tenant (the PENDING INSERT dropped).
      const beforeRows = rowsOfResult(
        await db
          .connection(centralConn())
          .rawQuery('SELECT count(*)::int AS n FROM backoffice.worm_ledger WHERE tenant_id = ?', [
            T,
          ])
      )
      assert.equal(Number(beforeRows[0]?.n), 0, 'a dropped PENDING append leaves no ledger row')

      // Recovery: with a healthy ledger the shred completes and is fully audited.
      const healthy = new CryptoService({
        keyProvider,
        store,
        erasabilityResolver: erasable(),
        ledger: new WormShredLedger(realWormWriter(T)),
      })
      const result = await healthy.shred(tenant(T), 'renter-1', CAT)
      assert.isTrue(result.shredded, 'the healthy shred destroys the DEK')
      assert.isNull(await store.findLive(tenant(T), 'renter-1', CAT), 'the DEK is tombstoned')
      const actions = rowsOfResult(
        await db
          .connection(centralConn())
          .rawQuery('SELECT action FROM backoffice.worm_ledger WHERE tenant_id = ? ORDER BY seq', [
            T,
          ])
      ).map((r) => String(r.action))
      assert.deepEqual(
        actions,
        ['crypto:shred:pending', 'crypto:shred:committed'],
        'the recovered shred wrote exactly one PENDING + one COMMITTED'
      )
    } finally {
      await dropTenantSchema(s, c)
    }
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
