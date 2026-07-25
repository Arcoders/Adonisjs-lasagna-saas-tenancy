import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import CryptoService from '../../../src/services/crypto_service.js'
import EnvKeyProvider from '../../../src/services/env_key_provider.js'
import {
  addTenantSchema,
  dropTenantSchema,
  harnessAs,
  probePg,
  tenant,
  type TenantSchema,
} from '../../helpers/real_crypto_pg.js'
import type {
  NewWrappedDekRow,
  WrappedDekRow,
  WrappedDekStore,
} from '../../../src/services/wrapped_dek_store.js'

/**
 * Fault-injection tier: the persistence layer drops during a provision.
 *
 * A first-write generates a DEK, wraps it, then INSERTs the wrapped-DEK row. This
 * injects a real database fault at the INSERT (as if Postgres dropped the connection
 * mid-write) and asserts, against real Postgres, that `encryptField` fails closed: it
 * never returns a ciphertext whose key was not durably stored (that value would be
 * unrecoverable), and the table is left with no row, so a later retry re-provisions
 * cleanly and the value round-trips. This is distinct from the KeyProvider-down spec,
 * which fails one layer up, at the wrap; here the wrap succeeds and the store write is
 * the fault.
 *
 * Injection wraps the real store's `insert` seam; every other store method delegates
 * to the real PgWrappedDekStore, so the recovery path exercises real persistence.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const CAT = 'identity-docs'
const TEST_KEY = 'crypto-fault-store-down-key-00000000!'

let ready = false
let originalAppKey: string | undefined

/** Delegate every store method to `real`, but drop the very next INSERT (once). */
function insertDropsOnce(real: WrappedDekStore): WrappedDekStore {
  let dropped = false
  return {
    findLive: (t, s, c) => real.findLive(t, s, c),
    listLive: (t, o) => real.listLive(t, o),
    shredLive: (t, s, c) => real.shredLive(t, s, c),
    rewrap: (t, id, w, k) => real.rewrap(t, id, w, k),
    insert(t, row: NewWrappedDekRow): Promise<WrappedDekRow> {
      if (!dropped) {
        dropped = true
        const err = new Error('write ECONNRESET') as Error & { code?: string }
        err.code = 'ECONNRESET'
        throw err
      }
      return real.insert(t, row)
    },
  }
}

test.group('crypto encrypt: the store INSERT drops mid-provision (real Postgres)', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return () => {}
    originalAppKey = process.env.APP_KEY
    process.env.APP_KEY = TEST_KEY
    return () => {
      if (originalAppKey === undefined) delete process.env.APP_KEY
      else process.env.APP_KEY = originalAppKey
    }
  })

  test('a dropped INSERT fails the encrypt closed (no orphan key), and a retry recovers', async ({
    assert,
  }) => {
    const T = randomUUID()
    const s = `crypto_sw_${suffix}_${T.slice(0, 8)}`
    const c = `crypto_sw_conn_${suffix}_${T.slice(0, 8)}`
    const routes: Record<string, TenantSchema> = { [T]: await addTenantSchema(s, c) }
    try {
      const { store } = harnessAs(T, { routes })
      const keyProvider = new EnvKeyProvider()

      // The first provision drops at the INSERT: encryptField fails closed. Returning a
      // ciphertext here would hand back a value whose DEK was never stored, hence
      // permanently unrecoverable, so the fail-closed throw is the correct posture.
      const flaky = new CryptoService({ keyProvider, store: insertDropsOnce(store) })
      await assert.rejects(
        () => flaky.encryptField(tenant(T), 'renter-1', CAT, 'a-passport-number'),
        /ECONNRESET/
      )
      assert.isNull(
        await store.findLive(tenant(T), 'renter-1', CAT),
        'a dropped INSERT leaves no wrapped-DEK row'
      )

      // Recovery: a retry against the real store provisions cleanly and round-trips.
      const healthy = new CryptoService({ keyProvider, store })
      const ciphertext = await healthy.encryptField(tenant(T), 'renter-1', CAT, 'a-passport-number')
      assert.match(ciphertext, /^enc_v2:/, 'the recovered write stores real ciphertext')
      assert.equal(
        await healthy.decryptField(tenant(T), 'renter-1', CAT, ciphertext),
        'a-passport-number',
        'the retry provisioned a durable DEK and the value round-trips'
      )
      const live = await store.findLive(tenant(T), 'renter-1', CAT)
      assert.isNotNull(live, 'exactly one live DEK exists after the successful retry')
    } finally {
      await dropTenantSchema(s, c)
    }
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
