import { test } from '@japa/runner'
import CryptoService from '../../../../src/services/crypto_service.js'
import EnvKeyProvider from '../../../../src/services/env_key_provider.js'
import InMemoryWrappedDekStore from '../../../../src/testing/in_memory_wrapped_dek_store.js'
import { tenant } from '../../../helpers/crypto_shred_fakes.js'
import type { KeyProvider, WrappedDek } from '../../../../src/types/key_provider.js'

const TEST_KEY = 'test-app-key-for-crypto-kms-down!!!!'
const T = tenant('tenant-1')
const S = 'renter-42'
const CAT = 'identity-docs'

/** A KeyProvider whose KMS backend is DOWN for unwrap (a read cannot recover the DEK). */
const unwrapDown: KeyProvider = {
  name: 'kms',
  async wrapDek(): Promise<WrappedDek> {
    return { kekId: 'k', ciphertext: 'unused' }
  },
  async unwrapDek(): Promise<Buffer> {
    throw new Error('KMS unreachable')
  },
}

/** A KeyProvider whose KMS backend is DOWN for wrap (a new value cannot be sealed). */
const wrapDown: KeyProvider = {
  name: 'kms',
  async wrapDek(): Promise<WrappedDek> {
    throw new Error('KMS unreachable')
  },
  async unwrapDek(): Promise<Buffer> {
    return Buffer.alloc(32)
  },
}

// §9 / I3, T6: "KeyProvider down (KMS/Vault unreachable) → fail-closed." A DEK that
// cannot be unwrapped makes the READ fail (never falls back to a shared/plaintext key);
// a DEK that cannot be wrapped makes the WRITE fail (a new encrypted value is never
// written unencrypted). crypto never degrades to plaintext on any path.
test.group('crypto KeyProvider down (KMS unreachable) — fail-closed reads and writes', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('a read whose DEK cannot be unwrapped fails closed (never returns plaintext)', async ({
    assert,
  }) => {
    const store = new InMemoryWrappedDekStore()
    // Provision + seal a value with a WORKING provider (env), so a live DEK row exists.
    const healthy = new CryptoService({ keyProvider: new EnvKeyProvider(), store })
    const ciphertext = await healthy.encryptField(T, S, CAT, 'passport-AB1234567')

    // Now the KMS is down for unwrap: the read must throw, not surface the ciphertext.
    const down = new CryptoService({ keyProvider: unwrapDown, store })
    const outcome = await down.decryptField(T, S, CAT, ciphertext).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e })
    )
    assert.isFalse(outcome.ok, 'a KMS-down read must reject, never resolve to plaintext')
  })

  test('a write whose DEK cannot be wrapped fails closed (nothing stored, no plaintext)', async ({
    assert,
  }) => {
    const store = new InMemoryWrappedDekStore()
    const down = new CryptoService({ keyProvider: wrapDown, store })

    await assert.rejects(() => down.encryptField(T, S, CAT, 'passport-AB1234567'))
    // Fail-closed: no live DEK was persisted, so no half-written/plaintext state remains.
    assert.isNull(await store.findLive(T, S, CAT))
  })
})
