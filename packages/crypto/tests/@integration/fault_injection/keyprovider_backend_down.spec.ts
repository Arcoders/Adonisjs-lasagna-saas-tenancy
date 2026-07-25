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
import type { KeyProvider, WrappedDek } from '../../../src/types/key_provider.js'

/**
 * Fault-injection tier: the KeyProvider (root of trust) backend is unreachable.
 *
 * The resilience-tier unit spec (resilience_keyprovider_kms_down) proves the policy
 * with in-memory doubles. This complements it against the booted app and real
 * Postgres: a KMS/Vault backend outage is injected at the `KeyProvider.wrapDek` /
 * `unwrapDek` seam (both drop with a realistic connection error), and we assert two
 * things a unit test cannot: (1) a write whose DEK cannot be wrapped fails closed and
 * leaves zero rows in the real wrapped-DEK table (no plaintext, no half-written DEK),
 * and (2) a read whose DEK cannot be unwrapped fails closed and never returns the
 * plaintext, while the same ciphertext still decrypts once the provider recovers.
 *
 * Injection follows the fault-tier stance: through the injected KeyProvider seam, so
 * no shared singleton is mutated: the real PgWrappedDekStore, real schema, and real
 * env provider (for the healthy path) are untouched.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const CAT = 'identity-docs'
const TEST_KEY = 'crypto-fault-kms-down-key-0000000000!'

let ready = false
let originalAppKey: string | undefined

/** A KeyProvider whose KMS/Vault backend is unreachable: wrap AND unwrap both drop. */
function kmsBackendDown(): KeyProvider {
  const drop = (): Error => {
    const err = new Error('read ECONNRESET') as Error & { code?: string }
    err.code = 'ECONNRESET'
    return err
  }
  return {
    name: 'kms-down',
    wrapDek(): Promise<WrappedDek> {
      throw drop()
    },
    unwrapDek(): Promise<Buffer> {
      throw drop()
    },
  }
}

test.group(
  'crypto KeyProvider backend down (KMS unreachable) fails closed on real Postgres',
  (group) => {
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

    test('a write whose DEK cannot be wrapped fails closed and stores NOTHING', async ({
      assert,
    }) => {
      const T = randomUUID()
      const s = `crypto_kw_${suffix}_${T.slice(0, 8)}`
      const c = `crypto_kw_conn_${suffix}_${T.slice(0, 8)}`
      const routes: Record<string, TenantSchema> = { [T]: await addTenantSchema(s, c) }
      try {
        const { store } = harnessAs(T, { routes })
        const broken = new CryptoService({ keyProvider: kmsBackendDown(), store })

        await assert.rejects(
          () => broken.encryptField(tenant(T), 'renter-w', CAT, 'a-passport-number'),
          /ECONNRESET/
        )
        // wrapDek runs before the store INSERT, so a failed wrap left no row at all.
        assert.isNull(
          await store.findLive(tenant(T), 'renter-w', CAT),
          'a wrap failure must leave no wrapped-DEK row (no plaintext, no half-write)'
        )
      } finally {
        await dropTenantSchema(s, c)
      }
    }).skip(() => !ready, 'postgres not available; runs in CI')

    test('a read whose DEK cannot be unwrapped fails closed, never plaintext, and recovers', async ({
      assert,
    }) => {
      const T = randomUUID()
      const s = `crypto_kr_${suffix}_${T.slice(0, 8)}`
      const c = `crypto_kr_conn_${suffix}_${T.slice(0, 8)}`
      const routes: Record<string, TenantSchema> = { [T]: await addTenantSchema(s, c) }
      try {
        const { store } = harnessAs(T, { routes })
        const healthy = new CryptoService({ keyProvider: new EnvKeyProvider(), store })
        const ciphertext = await healthy.encryptField(tenant(T), 'renter-r', CAT, 'top-secret')

        // The backend goes down: the read cannot unwrap the DEK, so it fails closed
        // (the raw connection error surfaces) rather than returning the ciphertext or a
        // plaintext fallback.
        const broken = new CryptoService({ keyProvider: kmsBackendDown(), store })
        await assert.rejects(
          () => broken.decryptField(tenant(T), 'renter-r', CAT, ciphertext),
          /ECONNRESET/
        )

        // Recovery: once the provider is healthy again, the SAME ciphertext decrypts.
        assert.equal(
          await healthy.decryptField(tenant(T), 'renter-r', CAT, ciphertext),
          'top-secret',
          'the ciphertext is intact; only the key backend was unavailable'
        )
      } finally {
        await dropTenantSchema(s, c)
      }
    }).skip(() => !ready, 'postgres not available; runs in CI')
  }
)
