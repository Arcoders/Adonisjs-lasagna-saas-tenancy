import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import CryptoService from '../../../../src/services/crypto_service.js'
import EnvKeyProvider from '../../../../src/services/env_key_provider.js'
import WormShredLedger from '../../../../src/services/worm_shred_ledger.js'
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
} from '../../../helpers/real_crypto_pg.js'
import { erasable } from '../../../helpers/crypto_shred_fakes.js'
import type {
  ShredLedger,
  PendingShredEntry,
  ShredLedgerEntry,
} from '../../../../src/types/shred_ledger.js'

/**
 * The crash-between-PENDING-and-COMMITTED failure mode, on real Postgres with
 * the real append-only WORM ledger. The two-phase shred writes a PENDING row before the
 * irreversible tombstone and a COMMITTED marker after. If the process crashes between the
 * two (here the COMMITTED append throws), the DEK is already destroyed, which is correct
 * because the erasure is irreversible, and a detectable PENDING row remains in the ledger
 * with no matching COMMITTED marker, so a reconciliation pass or an operator can find it.
 * The erasure is auditable; it is just not yet finalized. Never a silent success.
 * Self-skips when Postgres is unreachable (local), runs in CI.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const CAT = 'marketing'
const TEST_KEY = 'crypto-int-committed-fail-key-000000!'

let ready = false
let originalAppKey: string | undefined

/** A ledger that appends the real PENDING row, then fails the COMMITTED mark (a crash). */
function failCommitLedger(real: ShredLedger): ShredLedger {
  return {
    appendPending: (e: ShredLedgerEntry): Promise<PendingShredEntry> => real.appendPending(e),
    async markCommitted(): Promise<void> {
      throw new Error('simulated crash between PENDING and COMMITTED')
    },
  }
}

test.group('crypto shred: crash between PENDING and COMMITTED (real Postgres)', (group) => {
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

  test('the DEK is destroyed and an un-committed PENDING row remains for reconciliation', async ({
    assert,
  }) => {
    const T = randomUUID()
    const s = `crypto_cf_${suffix}_${T.slice(0, 8)}`
    const c = `crypto_cf_conn_${suffix}_${T.slice(0, 8)}`
    const routes: Record<string, TenantSchema> = { [T]: await addTenantSchema(s, c) }
    try {
      const { store, keyProvider } = harnessAs(T, { routes })
      const crypto = new CryptoService({
        keyProvider,
        store,
        erasabilityResolver: erasable(),
        ledger: failCommitLedger(new WormShredLedger(realWormWriter(T))),
      })

      const ciphertext = await crypto.encryptField(tenant(T), 'renter-1', CAT, 'x')

      // The shred completes the delete but the COMMITTED mark crashes, so it is reported, not silent.
      await assert.rejects(() => crypto.shred(tenant(T), 'renter-1', CAT), /unfinalized|COMPLETED/)

      // The DEK is gone: the value is now undecryptable (the erasure did happen).
      await assert.rejects(
        () => crypto.decryptField(tenant(T), 'renter-1', CAT, ciphertext),
        /no live DEK/
      )
      // The live row is tombstoned (shredded_at set, wrapped_dek nulled).
      assert.isNull(await store.findLive(tenant(T), 'renter-1', CAT))

      // A detectable PENDING row remains with no matching COMMITTED marker.
      const rows = rowsOfResult(
        await db
          .connection(centralConn())
          .rawQuery('SELECT action FROM backoffice.worm_ledger WHERE tenant_id = ? ORDER BY seq', [
            T,
          ])
      )
      const actions = rows.map((r) => String(r.action))
      assert.include(actions, 'crypto:shred:pending')
      assert.notInclude(actions, 'crypto:shred:committed')
    } finally {
      await dropTenantSchema(s, c)
    }
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
