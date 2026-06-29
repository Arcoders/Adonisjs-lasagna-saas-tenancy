import { test } from '@japa/runner'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import {
  encrypt,
  decrypt,
  decryptStrict,
  decryptWithAppKey,
  isEncrypted,
} from '../../../../src/utils/crypto.js'

const TEST_KEY = 'test-app-key-for-unit-tests-only!!'

/**
 * Build a genuine LEGACY `enc_v1` ciphertext the way the pre-v2 code did
 * (key = sha256(APP_KEY), AES-256-GCM, no AAD, 3 segments). Independent of the
 * production module so the backward-read test cannot pass by accident.
 */
function makeLegacyV1(plaintext: string, appKey: string): string {
  const key = createHash('sha256').update(appKey).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc_v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

test.group('crypto — encrypt / decrypt', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })

  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('encrypt returns a string starting with enc_v2:', ({ assert }) => {
    const ciphertext = encrypt('hello world')
    assert.isTrue(ciphertext.startsWith('enc_v2:'))
  })

  test('encrypt result has four colon-separated segments after the prefix (keyId:iv:tag:cipher)', ({
    assert,
  }) => {
    const ciphertext = encrypt('data')
    const withoutPrefix = ciphertext.slice('enc_v2:'.length)
    const parts = withoutPrefix.split(':')
    assert.lengthOf(parts, 4)
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

  test('decrypt throws for enc_v1 value with wrong segment count', ({ assert }) => {
    assert.throws(() => decrypt('enc_v1:onlyone'), /Invalid encrypted value format/)
    assert.throws(() => decrypt('enc_v1:a:b:c:d'), /Invalid encrypted value format/)
  })

  test('decrypt throws for enc_v2 value with wrong segment count', ({ assert }) => {
    assert.throws(() => decrypt('enc_v2:onlyone'), /Invalid encrypted value format/)
    assert.throws(() => decrypt('enc_v2:a:b:c'), /Invalid encrypted value format/)
    assert.throws(() => decrypt('enc_v2:a:b:c:d:e'), /Invalid encrypted value format/)
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

  test('returns true for a value produced by encrypt (enc_v2)', ({ assert }) => {
    assert.isTrue(isEncrypted(encrypt('anything')))
  })

  test('returns true for a legacy enc_v1 value', ({ assert }) => {
    assert.isTrue(isEncrypted('enc_v1:aa:bb:cc'))
  })

  test('returns false for a plain string', ({ assert }) => {
    assert.isFalse(isEncrypted('plain text'))
  })

  test('returns false for an empty string', ({ assert }) => {
    assert.isFalse(isEncrypted(''))
  })

  test('returns false for an unknown version or wrong-case prefix', ({ assert }) => {
    assert.isFalse(isEncrypted('enc_v0:something'))
    assert.isFalse(isEncrypted('enc_v9:something'))
    assert.isFalse(isEncrypted('ENC_V2:something'))
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
    assert.throws(() => decryptWithAppKey('plain', TEST_KEY), /not enc_v1\/enc_v2 ciphertext/)
  })

  test('decryptStrict rejects a non-prefixed value (no plaintext passthrough)', ({ assert }) => {
    assert.throws(() => decryptStrict('not ciphertext'), /not enc_v1\/enc_v2 ciphertext/)
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

// WS-4 / crypto-kdf-envelope-permanence. The v2 envelope adds HKDF key
// derivation, a key id, and GCM AAD over the header. These tests freeze that
// format and prove it round-trips, still reads enc_v1, and rejects tampering.
test.group('crypto — enc_v2 envelope', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('envelope carries a non-empty key-id segment before the iv', ({ assert }) => {
    const ciphertext = encrypt('payload')
    const [prefix, keyId, iv, tag, cipher] = ciphertext.split(':')
    assert.equal(prefix, 'enc_v2')
    assert.isAbove(keyId.length, 0, 'key id segment must be present')
    assert.match(keyId, /^[0-9a-f]+$/, 'key id is hex')
    // iv/tag/cipher are all present and hex
    for (const seg of [iv, tag, cipher]) assert.match(seg, /^[0-9a-f]+$/)
  })

  test('round-trips a value through encrypt -> decrypt', ({ assert }) => {
    assert.equal(decrypt(encrypt('top secret')), 'top secret')
  })

  test('still decrypts a legacy enc_v1 value written by the old format', ({ assert }) => {
    const legacy = makeLegacyV1('legacy secret', TEST_KEY)
    assert.isTrue(isEncrypted(legacy))
    assert.equal(decrypt(legacy), 'legacy secret')
    assert.equal(decryptStrict(legacy), 'legacy secret')
  })

  test('a custom context derives a different key (cross-context decrypt fails)', ({ assert }) => {
    const ciphertext = encrypt('classified', 'lasagna:class-a')
    assert.equal(decrypt(ciphertext, 'lasagna:class-a'), 'classified')
    // Decrypting with the default context (different HKDF info) must fail.
    assert.throws(() => decrypt(ciphertext))
  })

  test('AAD binds the iv: tampering the iv segment fails the auth tag', ({ assert }) => {
    const [prefix, keyId, iv, tag, cipher] = encrypt('immutable').split(':')
    const flipped = iv.slice(0, -1) + (iv.at(-1) === '0' ? '1' : '0')
    const tampered = [prefix, keyId, flipped, tag, cipher].join(':')
    assert.throws(() => decrypt(tampered))
  })

  test('tampering the key-id segment is rejected with a clear key-id error', ({ assert }) => {
    const [prefix, keyId, iv, tag, cipher] = encrypt('immutable').split(':')
    const flipped = keyId.slice(0, -1) + (keyId.at(-1) === '0' ? '1' : '0')
    const tampered = [prefix, flipped, iv, tag, cipher].join(':')
    assert.throws(() => decrypt(tampered), /different APP_KEY|key id mismatch/)
  })

  test('tampering the ciphertext fails the auth tag', ({ assert }) => {
    const [prefix, keyId, iv, tag, cipher] = encrypt('immutable').split(':')
    const flipped = cipher.slice(0, -1) + (cipher.at(-1) === '0' ? '1' : '0')
    const tampered = [prefix, keyId, iv, tag, flipped].join(':')
    assert.throws(() => decrypt(tampered))
  })

  test('a wrong APP_KEY reports a key-id mismatch, not an opaque failure', ({ assert }) => {
    const ciphertext = encrypt('secret')
    process.env.APP_KEY = 'a-completely-different-application-key!!'
    assert.throws(() => decrypt(ciphertext), /different APP_KEY|key id mismatch/)
  })

  test('decryptWithAppKey reads an enc_v2 value written under another key', ({ assert }) => {
    const ciphertext = encrypt('rotate me') // under TEST_KEY
    process.env.APP_KEY = 'the-new-rotated-application-key!!!'
    assert.throws(() => decrypt(ciphertext)) // current key no longer matches
    assert.equal(decryptWithAppKey(ciphertext, TEST_KEY), 'rotate me')
  })
})
