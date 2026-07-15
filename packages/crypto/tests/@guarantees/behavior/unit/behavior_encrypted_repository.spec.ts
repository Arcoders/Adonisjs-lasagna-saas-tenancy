import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import CryptoService from '../../../../src/services/crypto_service.js'
import EncryptedRepository from '../../../../src/services/encrypted_repository.js'
import EnvKeyProvider from '../../../../src/services/env_key_provider.js'
import InMemoryWrappedDekStore from '../../../../src/testing/in_memory_wrapped_dek_store.js'
import type { ErasabilityResolver } from '../../../../src/types/erasability.js'
import type { ShredLedger } from '../../../../src/types/shred_ledger.js'
import { erasable, RecordingLedger, tenant } from '../../../helpers/crypto_shred_fakes.js'

const TEST_KEY = 'test-app-key-for-crypto-slice-only!!'
const S = 'renter-42'
const CAT = 'identity-docs'

/** A repository over an env-backed CryptoService, with the current tenant fixed to `t`. */
function makeRepo(
  t: TenantModelContract | null,
  opts: { erasabilityResolver?: ErasabilityResolver; ledger?: ShredLedger } = {}
) {
  const crypto = new CryptoService({
    keyProvider: new EnvKeyProvider(),
    store: new InMemoryWrappedDekStore(),
    erasabilityResolver: opts.erasabilityResolver,
    ledger: opts.ledger,
  })
  const repo = new EncryptedRepository({ crypto, resolveCurrentTenant: async () => t })
  return { repo, crypto }
}

// The EncryptedRepository is a context-aware facade over CryptoService. It resolves
// the current tenant from the active scope (so the caller passes only
// subject/category/value), delegates encrypt/decrypt/blindIndex/shred, and is
// fail-closed when there is no tenant scope (never a cross-tenant DEK).
test.group('crypto EncryptedRepository: explicit field-encryption facade', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('encrypts then decrypts a value, resolving the tenant from context', async ({ assert }) => {
    const { repo } = makeRepo(tenant('tenant-1'))
    const ciphertext = await repo.encrypt(S, CAT, 'passport-AB1234567')
    assert.isTrue(ciphertext.startsWith('enc_v2:'), 'stored as enc_v2 ciphertext, not plaintext')
    assert.notInclude(ciphertext, 'passport-AB1234567')
    assert.equal(await repo.decrypt(S, CAT, ciphertext), 'passport-AB1234567')
  })

  test('a value for one subject cannot be read under another (fail-closed)', async ({ assert }) => {
    const { repo } = makeRepo(tenant('tenant-1'))
    const ciphertext = await repo.encrypt('subject-A', CAT, 'secret')
    await assert.rejects(() => repo.decrypt('subject-B', CAT, ciphertext), /no live DEK/)
  })

  test('blindIndex delegates: equal values index equally', async ({ assert }) => {
    const { repo } = makeRepo(tenant('tenant-1'))
    const a = await repo.blindIndex(CAT, 'passport-AB1234567')
    const b = await repo.blindIndex(CAT, 'passport-AB1234567')
    const c = await repo.blindIndex(CAT, 'passport-ZZ9999999')
    assert.equal(a, b)
    assert.notEqual(a, c)
  })

  test('shred delegates through the gate + ledger; the value is then undecryptable', async ({
    assert,
  }) => {
    const { repo } = makeRepo(tenant('tenant-1'), {
      erasabilityResolver: erasable(),
      ledger: new RecordingLedger(),
    })
    const ciphertext = await repo.encrypt(S, CAT, 'passport-AB1234567')
    const result = await repo.shred(S, CAT)
    assert.isTrue(result.shredded)
    await assert.rejects(() => repo.decrypt(S, CAT, ciphertext), /no live DEK/)
  })

  test('fail-closed: with no active tenant scope every method refuses', async ({ assert }) => {
    const { repo } = makeRepo(null)
    await assert.rejects(() => repo.encrypt(S, CAT, 'x'), /no active tenant scope/)
    await assert.rejects(() => repo.decrypt(S, CAT, 'enc_v2:a:b:c:d'), /no active tenant scope/)
    await assert.rejects(() => repo.blindIndex(CAT, 'x'), /no active tenant scope/)
    await assert.rejects(() => repo.shred(S, CAT), /no active tenant scope/)
  })
})
