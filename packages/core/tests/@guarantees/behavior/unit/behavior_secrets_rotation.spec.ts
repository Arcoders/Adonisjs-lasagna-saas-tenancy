import { test } from '@japa/runner'
import { encrypt } from '../../../../src/utils/crypto.js'
import { classifySecretRotation } from '../../../../src/utils/secrets_rotation.js'

/**
 * `classifySecretRotation` is the dangerous core of `tenant:secrets:reencrypt`:
 * it decides, per stored secret, whether to re-encrypt under the new APP_KEY,
 * leave it (already current), report it unrecoverable, or skip it. A bug in this
 * branch selection silently corrupts secrets that cannot be recovered, so every
 * branch is pinned here with real crypto round-trips.
 */

const OLD_KEY = 'old-app-key-aaaaaaaaaaaaaaaaaaaaaaaa'
const CURRENT_KEY = 'current-app-key-bbbbbbbbbbbbbbbbbbbb'
const THIRD_KEY = 'unknown-app-key-cccccccccccccccccccc'

/** Encrypt `plaintext` under an arbitrary APP_KEY (encrypt() reads it from env). */
function encryptUnder(appKey: string, plaintext: string): string {
  const prev = process.env.APP_KEY
  process.env.APP_KEY = appKey
  try {
    return encrypt(plaintext)
  } finally {
    if (prev === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = prev
  }
}

test.group('classifySecretRotation', () => {
  test('skips a plaintext-era (non-ciphertext) value', ({ assert }) => {
    assert.deepEqual(classifySecretRotation('raw-plaintext-secret', OLD_KEY, CURRENT_KEY), {
      action: 'skip',
    })
  })

  test('rotates a value encrypted under the OLD key, recovering the exact plaintext', ({
    assert,
  }) => {
    const stored = encryptUnder(OLD_KEY, 'whsec_super-secret-value')
    assert.deepEqual(classifySecretRotation(stored, OLD_KEY, CURRENT_KEY), {
      action: 'rotate',
      plaintext: 'whsec_super-secret-value',
    })
  })

  test('reports a value already under the CURRENT key as current (idempotent re-run)', ({
    assert,
  }) => {
    const stored = encryptUnder(CURRENT_KEY, 'whsec_already-rotated')
    assert.deepEqual(classifySecretRotation(stored, OLD_KEY, CURRENT_KEY), { action: 'current' })
  })

  test('fails a value that decrypts under neither key', ({ assert }) => {
    const stored = encryptUnder(THIRD_KEY, 'whsec_from-a-third-generation')
    assert.deepEqual(classifySecretRotation(stored, OLD_KEY, CURRENT_KEY), { action: 'failed' })
  })

  test('fails a corrupted ciphertext rather than treating it as plaintext', ({ assert }) => {
    const stored = encryptUnder(OLD_KEY, 'whsec_value')
    // Flip the last ciphertext hex char so the GCM auth tag check fails.
    const corrupted = stored.slice(0, -1) + (stored.endsWith('a') ? 'b' : 'a')
    assert.deepEqual(classifySecretRotation(corrupted, OLD_KEY, CURRENT_KEY), { action: 'failed' })
  })

  test('fails an enc_v1 prefix with a malformed body', ({ assert }) => {
    assert.deepEqual(classifySecretRotation('enc_v1:not-a-valid-body', OLD_KEY, CURRENT_KEY), {
      action: 'failed',
    })
  })
})
