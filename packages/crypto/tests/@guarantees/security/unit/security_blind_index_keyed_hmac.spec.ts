import { createHash } from 'node:crypto'
import { test } from '@japa/runner'
import CryptoService from '../../../../src/services/crypto_service.js'
import EnvKeyProvider from '../../../../src/services/env_key_provider.js'
import InMemoryWrappedDekStore from '../../../../src/testing/in_memory_wrapped_dek_store.js'
import type { CategoryKey, KeyProvider, WrappedDek } from '../../../../src/types/key_provider.js'
import {
  erasable,
  makeService,
  RecordingLedger,
  tenant,
} from '../../../helpers/crypto_shred_fakes.js'

const TEST_KEY = 'test-app-key-for-crypto-slice-only!!'
const T = tenant('tenant-1')
const CAT: CategoryKey = 'identity-docs'

/** A blindIndex-only service: the env provider yields the index key; the store is unused. */
function svc(provider: KeyProvider = new EnvKeyProvider()) {
  return new CryptoService({ keyProvider: provider, store: new InMemoryWrappedDekStore() })
}

/** A KeyProvider that wraps/unwraps but does not support blind indexing. */
class NoIndexProvider implements KeyProvider {
  // Typed as the contract's `string`, not the inferred 'no-index' literal, so the
  // subclasses below can name themselves.
  readonly name: string = 'no-index'
  async wrapDek(): Promise<WrappedDek> {
    throw new Error('unused')
  }
  async unwrapDek(): Promise<Buffer> {
    throw new Error('unused')
  }
}

/** A KeyProvider whose index-key derivation fails (a KMS outage). */
class ThrowingIndexProvider extends NoIndexProvider {
  override readonly name = 'throwing'
  async deriveIndexKey(): Promise<Buffer> {
    throw new Error('KMS unreachable')
  }
}

/** A KeyProvider that returns a too-short (weak) index key. */
class ShortKeyProvider extends NoIndexProvider {
  override readonly name = 'short'
  async deriveIndexKey(): Promise<Buffer> {
    return Buffer.alloc(16)
  }
}

// Equality search uses a keyed HMAC (a blind index), not a bare salted
// hash. Equal plaintexts index equally (so equality search works), the key lives
// in the KeyProvider (so a DB dump cannot brute-force it), the index key is
// distinct from the DEK and survives a crypto-shred, and the documented
// equality/frequency leak is an honest invariant, never silent.
test.group('crypto blind index: keyed HMAC for equality search', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('equal plaintexts index equally; different plaintexts do not', async ({ assert }) => {
    const service = svc()
    const a = await service.blindIndex(T, CAT, 'passport-AB1234567')
    const b = await service.blindIndex(T, CAT, 'passport-AB1234567')
    const c = await service.blindIndex(T, CAT, 'passport-ZZ9999999')
    assert.equal(a, b, 'equality search: the same value indexes to the same HMAC')
    assert.notEqual(a, c, 'different values index to different HMACs')
  })

  test('the index is a 64-char hex digest, never the plaintext', async ({ assert }) => {
    const index = await svc().blindIndex(T, CAT, 'passport-AB1234567')
    assert.match(index, /^[0-9a-f]{64}$/)
    assert.notInclude(index, 'passport')
  })

  test('it is KEYED, not a bare hash: it does not match sha256(value)', async ({ assert }) => {
    const value = 'passport-AB1234567'
    const index = await svc().blindIndex(T, CAT, value)
    const bareHash = createHash('sha256').update(value, 'utf8').digest('hex')
    assert.notEqual(index, bareHash, 'a bare-hash dictionary must not recover the value')
  })

  test('a different APP_KEY yields a different index key, so the index changes', async ({
    assert,
  }) => {
    const value = 'passport-AB1234567'
    const withKey1 = await svc().blindIndex(T, CAT, value)
    process.env.APP_KEY = 'a-totally-different-app-key-value!!!'
    const withKey2 = await svc().blindIndex(T, CAT, value)
    assert.notEqual(
      withKey1,
      withKey2,
      'the HMAC depends on the KeyProvider key, not just the value'
    )
  })

  test('the same value indexes differently per category (key separation)', async ({ assert }) => {
    const service = svc()
    const idDocs = await service.blindIndex(T, 'identity-docs', 'shared-value')
    const marketing = await service.blindIndex(T, 'marketing', 'shared-value')
    assert.notEqual(idDocs, marketing)
  })

  test('the same value indexes differently per tenant (isolation)', async ({ assert }) => {
    const service = svc()
    const t1 = await service.blindIndex(tenant('tenant-1'), CAT, 'shared-value')
    const t2 = await service.blindIndex(tenant('tenant-2'), CAT, 'shared-value')
    assert.notEqual(t1, t2)
  })

  test('NFKC + trim normalization makes two spellings of one value collide', async ({ assert }) => {
    const service = svc()
    // Full-width digits (U+FF11..) NFKC-fold to ASCII; surrounding whitespace is trimmed.
    const canonical = await service.blindIndex(T, CAT, '123456')
    const fullWidth = await service.blindIndex(T, CAT, '１２３４５６')
    const padded = await service.blindIndex(T, CAT, '  123456  ')
    assert.equal(fullWidth, canonical, 'NFKC folds compatibility encodings')
    assert.equal(padded, canonical, 'surrounding whitespace is trimmed')
  })

  test('case-folding is opt-in: default is case-sensitive, caseInsensitive folds', async ({
    assert,
  }) => {
    const service = svc()
    const lower = await service.blindIndex(T, CAT, 'ab1234567')
    const upper = await service.blindIndex(T, CAT, 'AB1234567')
    assert.notEqual(lower, upper, 'default: case matters')

    const lowerCI = await service.blindIndex(T, CAT, 'ab1234567', { caseInsensitive: true })
    const upperCI = await service.blindIndex(T, CAT, 'AB1234567', { caseInsensitive: true })
    assert.equal(lowerCI, upperCI, 'caseInsensitive: case is folded')
  })

  test('the blind index SURVIVES a crypto-shred: the index key is not the DEK', async ({
    assert,
  }) => {
    const { service } = makeService({
      erasabilityResolver: erasable(),
      ledger: new RecordingLedger(),
    })
    const S = 'renter-42'
    const value = 'passport-AB1234567'
    const before = await service.blindIndex(T, CAT, value)

    // Provision the (subject × category) DEK by writing a field, then shred it.
    await service.encryptField(T, S, CAT, value)
    const result = await service.shred(T, S, CAT)
    assert.isTrue(result.shredded, 'the DEK was destroyed')

    // The DEK is gone (the field ciphertext is now inert), but equality is still
    // computable for surviving rows: the index key outlived the shred.
    const after = await service.blindIndex(T, CAT, value)
    assert.equal(
      after,
      before,
      'the index key survives the shred; the leak persists (host must null the column)'
    )
    await assert.rejects(() => service.decryptField(T, S, CAT, before), /no live DEK/)
  })

  test('fail-closed: a provider without deriveIndexKey refuses (never a bare hash)', async ({
    assert,
  }) => {
    await assert.rejects(
      () => svc(new NoIndexProvider()).blindIndex(T, CAT, 'x'),
      /does not support blind indexing/
    )
  })

  test('fail-closed: a provider whose index-key derivation throws refuses', async ({ assert }) => {
    await assert.rejects(
      () => svc(new ThrowingIndexProvider()).blindIndex(T, CAT, 'x'),
      /yielded no index key/
    )
  })

  test('fail-closed: a too-short index key is refused (never a weakly-keyed HMAC)', async ({
    assert,
  }) => {
    await assert.rejects(
      () => svc(new ShortKeyProvider()).blindIndex(T, CAT, 'x'),
      /at least 32 bytes/
    )
  })
})
