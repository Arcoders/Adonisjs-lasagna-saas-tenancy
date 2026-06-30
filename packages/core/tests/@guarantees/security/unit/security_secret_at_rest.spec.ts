import { test } from '@japa/runner'
import { encrypt } from '../../../../src/utils/crypto.js'
import { readSecret, writeSecret, SECRET_CLASS } from '../../../../src/utils/secret_at_rest.js'

/**
 * WS-1: the canonical secret-at-rest accessor is the single seam every stored
 * secret reads and writes through. Two guarantees are pinned here:
 *
 *   1. FAIL CLOSED. readSecret rejects anything that is not ciphertext for the
 *      class (plaintext, corruption, tampering), so a downgraded value can never
 *      be used as a live secret.
 *   2. DOMAIN SEPARATED. Each class encrypts under its own HKDF context, so a
 *      ciphertext written for one class does not decrypt as another (confused
 *      deputy resistance) and a future class is isolated from existing ones.
 */

const TEST_KEY = 'secret-at-rest-unit-test-app-key!!'

test.group('secret_at_rest accessor', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('round-trips within a class', ({ assert }) => {
    const stored = writeSecret('whsec_value', 'webhookSecret')
    assert.isTrue(stored.startsWith('enc_v2:'))
    assert.equal(readSecret(stored, 'webhookSecret'), 'whsec_value')
  })

  test('readSecret fails closed on a plaintext value (no passthrough)', ({ assert }) => {
    assert.throws(
      () => readSecret('plaintext-secret', 'ssoClientSecret'),
      /not enc_v1\/enc_v2 ciphertext/
    )
  })

  test('readSecret fails closed on a tampered ciphertext', ({ assert }) => {
    const stored = writeSecret('client_secret_value', 'ssoClientSecret')
    const tampered = stored.slice(0, -1) + (stored.endsWith('a') ? 'b' : 'a')
    assert.throws(() => readSecret(tampered, 'ssoClientSecret'))
  })

  test('cross-class read fails: a webhook ciphertext does not decrypt as an SSO secret', ({
    assert,
  }) => {
    const webhookCipher = writeSecret('shared-bytes', 'webhookSecret')
    // Same plaintext, same APP_KEY, different class context => different key.
    assert.throws(() => readSecret(webhookCipher, 'ssoClientSecret'))
  })

  test('each class uses a distinct, non-default crypto context', ({ assert }) => {
    const contexts = Object.values(SECRET_CLASS)
    assert.equal(new Set(contexts).size, contexts.length, 'class contexts must be unique')
    // A value written under the legacy default context must NOT read under a class.
    const legacy = encrypt('legacy-default-context')
    assert.throws(() => readSecret(legacy, 'webhookSecret'))
    assert.throws(() => readSecret(legacy, 'ssoClientSecret'))
  })
})
