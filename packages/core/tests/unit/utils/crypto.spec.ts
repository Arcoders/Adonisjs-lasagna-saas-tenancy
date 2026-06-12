import { test } from '@japa/runner'
import {
  encrypt,
  decrypt,
  decryptStrict,
  decryptWithAppKey,
  isEncrypted,
} from '../../../src/utils/crypto.js'

const TEST_KEY = 'test-app-key-for-unit-tests-only!!'

test.group('crypto — encrypt / decrypt', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })

  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('encrypt returns a string starting with enc_v1:', ({ assert }) => {
    const ciphertext = encrypt('hello world')
    assert.isTrue(ciphertext.startsWith('enc_v1:'))
  })

  test('encrypt result has three colon-separated segments after the prefix', ({ assert }) => {
    const ciphertext = encrypt('data')
    const withoutPrefix = ciphertext.slice('enc_v1:'.length)
    const parts = withoutPrefix.split(':')
    assert.lengthOf(parts, 3)
  })

  test('decrypt recovers original plaintext', ({ assert }) => {
    const plaintext = 'secret value'
    const ciphertext = encrypt(plaintext)
    assert.equal(decrypt(ciphertext), plaintext)
  })

  test('two encryptions of the same plaintext produce different ciphertexts', ({ assert }) => {
    const a = encrypt('same input')
    const b = encrypt('same input')
    assert.notEqual(a, b)
  })

  test('roundtrip works with empty string', ({ assert }) => {
    const ciphertext = encrypt('')
    assert.equal(decrypt(ciphertext), '')
  })

  test('roundtrip works with unicode and special characters', ({ assert }) => {
    const special = '你好世界 <script>alert("xss")</script> \n\t\r'
    assert.equal(decrypt(encrypt(special)), special)
  })

  test('roundtrip works with a very long string', ({ assert }) => {
    const long = 'a'.repeat(10_000)
    assert.equal(decrypt(encrypt(long)), long)
  })

  test('decrypt passes through a non-prefixed value unchanged', ({ assert }) => {
    const plain = 'not encrypted at all'
    assert.equal(decrypt(plain), plain)
  })

  test('decrypt throws for value with prefix but wrong segment count', ({ assert }) => {
    assert.throws(() => decrypt('enc_v1:onlyone'), /Invalid encrypted value format/)
    assert.throws(() => decrypt('enc_v1:a:b:c:d'), /Invalid encrypted value format/)
  })

  test('decrypt throws with wrong key for valid ciphertext', ({ assert }) => {
    const ciphertext = encrypt('secret')
    process.env.APP_KEY = 'a-completely-different-key-here!!'
    assert.throws(() => decrypt(ciphertext))
  })
})

test.group('crypto — isEncrypted', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })

  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('returns true for a value produced by encrypt', ({ assert }) => {
    assert.isTrue(isEncrypted(encrypt('anything')))
  })

  test('returns false for a plain string', ({ assert }) => {
    assert.isFalse(isEncrypted('plain text'))
  })

  test('returns false for an empty string', ({ assert }) => {
    assert.isFalse(isEncrypted(''))
  })

  test('returns false for a similar but wrong prefix', ({ assert }) => {
    assert.isFalse(isEncrypted('enc_v2:something'))
    assert.isFalse(isEncrypted('ENC_V1:something'))
  })
})

// P3-3: rotation tooling. `decryptWithAppKey` is what tenant:secrets:reencrypt
// uses to read values written under the PREVIOUS key; `decryptStrict` is for
// call sites where a non-prefixed value can only mean corruption.
test.group('crypto — key rotation + strict mode', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('decryptWithAppKey reads a value written under a different APP_KEY', ({ assert }) => {
    const ciphertext = encrypt('rotate me') // written under TEST_KEY
    process.env.APP_KEY = 'the-new-rotated-application-key!!'
    // The process key no longer decrypts it…
    assert.throws(() => decrypt(ciphertext))
    // …but the rotation path, given the old key explicitly, does.
    assert.equal(decryptWithAppKey(ciphertext, TEST_KEY), 'rotate me')
  })

  test('the full rotation round-trip: old-key decrypt, new-key encrypt, plain decrypt', ({
    assert,
  }) => {
    const ciphertext = encrypt('webhook-signing-secret')
    process.env.APP_KEY = 'the-new-rotated-application-key!!'
    const reencrypted = encrypt(decryptWithAppKey(ciphertext, TEST_KEY))
    assert.equal(decrypt(reencrypted), 'webhook-signing-secret')
  })

  test('decryptWithAppKey rejects a non-ciphertext value instead of passing it through', ({
    assert,
  }) => {
    assert.throws(() => decryptWithAppKey('plain', TEST_KEY), /not enc_v1 ciphertext/)
  })

  test('decryptStrict rejects a non-prefixed value (no plaintext passthrough)', ({ assert }) => {
    assert.throws(() => decryptStrict('not ciphertext'), /not enc_v1 ciphertext/)
    assert.equal(decryptStrict(encrypt('x')), 'x')
  })
})

test.group('crypto — missing APP_KEY', () => {
  test('encrypt throws when APP_KEY is not set', ({ assert }) => {
    delete process.env.APP_KEY
    assert.throws(() => encrypt('test'), /APP_KEY environment variable is not set/)
  })

  test('decrypt throws when APP_KEY is not set and value has prefix', ({ assert }) => {
    process.env.APP_KEY = TEST_KEY
    const ciphertext = encrypt('data')
    delete process.env.APP_KEY
    assert.throws(() => decrypt(ciphertext), /APP_KEY environment variable is not set/)
  })
})
