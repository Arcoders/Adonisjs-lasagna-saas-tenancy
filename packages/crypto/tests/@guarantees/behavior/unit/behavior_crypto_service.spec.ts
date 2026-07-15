import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import CryptoService from '../../../../src/services/crypto_service.js'
import EnvKeyProvider from '../../../../src/services/env_key_provider.js'
import InMemoryWrappedDekStore from '../../../../src/testing/in_memory_wrapped_dek_store.js'

const TEST_KEY = 'test-app-key-for-crypto-slice-only!!'

function tenant(id: string): TenantModelContract {
  return { id } as unknown as TenantModelContract
}

/** A fresh service wired to the env provider + an in-memory store (one per test). */
function makeService() {
  const store = new InMemoryWrappedDekStore()
  const service = new CryptoService({ keyProvider: new EnvKeyProvider(), store })
  return { service, store }
}

// The vertical-slice end-to-end proof: a field value is sealed under a
// per-(subject × category) DEK (env KeyProvider wraps the DEK, the enc_v2 seam
// seals the value), and decrypts back only through that DEK. Every failure path
// is fail-closed: a missing DEK or a wrong DEK/category/tenant throws, never
// returns plaintext.
test.group('crypto service: field round-trip under a per-(subject × category) DEK', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  const T = tenant('tenant-1')
  const S = 'renter-42'
  const CAT = 'identity-docs'

  test('encrypts then decrypts a field value back to the original', async ({ assert }) => {
    const { service } = makeService()
    const ciphertext = await service.encryptField(T, S, CAT, 'passport-AB1234567')
    assert.isTrue(ciphertext.startsWith('enc_v2:'), 'stored as enc_v2 ciphertext, not plaintext')
    assert.notInclude(ciphertext, 'passport-AB1234567')
    assert.equal(await service.decryptField(T, S, CAT, ciphertext), 'passport-AB1234567')
  })

  test('provisions the DEK once and reuses it for later writes of the same (subject, category)', async ({
    assert,
  }) => {
    const { service, store } = makeService()
    const c1 = await service.encryptField(T, S, CAT, 'first')
    const c2 = await service.encryptField(T, S, CAT, 'second')
    // One live DEK row for (subject, category), reused across writes.
    assert.isNotNull(await store.findLive(T, S, CAT))
    assert.equal(await service.decryptField(T, S, CAT, c1), 'first')
    assert.equal(await service.decryptField(T, S, CAT, c2), 'second')
  })

  test('two encryptions of the same value differ (random IV) but both decrypt', async ({
    assert,
  }) => {
    const { service } = makeService()
    const a = await service.encryptField(T, S, CAT, 'same')
    const b = await service.encryptField(T, S, CAT, 'same')
    assert.notEqual(a, b)
    assert.equal(await service.decryptField(T, S, CAT, a), 'same')
    assert.equal(await service.decryptField(T, S, CAT, b), 'same')
  })

  test('a value sealed for one category cannot be read under another', async ({ assert }) => {
    const { service } = makeService()
    const idDocs = await service.encryptField(T, S, 'identity-docs', 'secret')
    // marketing was never provisioned for this subject: fail-closed, no plaintext.
    await assert.rejects(() => service.decryptField(T, S, 'marketing', idDocs), /no live DEK/)
    // Provision marketing too, then the wrong-category DEK fails the GCM tag.
    await service.encryptField(T, S, 'marketing', 'other')
    await assert.rejects(() => service.decryptField(T, S, 'marketing', idDocs))
  })

  test('a value sealed for one tenant cannot be read under another (isolation)', async ({
    assert,
  }) => {
    const { service } = makeService()
    const ciphertext = await service.encryptField(tenant('tenant-1'), S, CAT, 'secret')
    await assert.rejects(
      () => service.decryptField(tenant('tenant-2'), S, CAT, ciphertext),
      /no live DEK/
    )
  })

  test('decrypting a never-provisioned (subject, category) is fail-closed', async ({ assert }) => {
    const { service } = makeService()
    await assert.rejects(
      () => service.decryptField(T, 'nobody', CAT, 'enc_v2:aa:bb:cc:dd'),
      /no live DEK/
    )
  })

  test('a tampered ciphertext fails the auth tag (fail-closed read)', async ({ assert }) => {
    const { service } = makeService()
    const ciphertext = await service.encryptField(T, S, CAT, 'immutable')
    const parts = ciphertext.split(':')
    const cipher = parts[4]
    parts[4] = cipher.slice(0, -1) + (cipher.at(-1) === '0' ? '1' : '0')
    await assert.rejects(() => service.decryptField(T, S, CAT, parts.join(':')))
  })

  test('the second concurrent live provision for one (subject, category) is refused', async ({
    assert,
  }) => {
    const { store } = makeService()
    await store.insert(T, { subjectId: S, category: CAT, wrappedDek: 'w1', kekId: 'k1' })
    await assert.rejects(
      () => store.insert(T, { subjectId: S, category: CAT, wrappedDek: 'w2', kekId: 'k2' }),
      /already exists/
    )
  })
})
