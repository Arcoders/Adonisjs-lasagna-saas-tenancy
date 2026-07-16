import { test } from '@japa/runner'
import { encrypt } from '../../../../src/utils/crypto.js'
import { classifySecretRotation } from '../../../../src/utils/secrets_rotation.js'

/**
 * `classifySecretRotation` is the dangerous core of `tenant:secrets:reencrypt`:
 * it decides, per stored secret, whether to recover-and-re-encrypt under the
 * current APP_KEY + target context, leave it (already there), or report it
 * unrecoverable. A bug in this branch selection silently corrupts secrets that
 * cannot be recovered, so every branch is pinned here with real crypto
 * round-trips across BOTH migration axes (key rotation and context migration).
 */

const OLD_KEY = 'old-app-key-aaaaaaaaaaaaaaaaaaaaaaaa'
const CURRENT_KEY = 'current-app-key-bbbbbbbbbbbbbbbbbbbb'
const THIRD_KEY = 'unknown-app-key-cccccccccccccccccccc'

// The legacy shared context (crypto's default) versus the per-class target.
const TARGET_CTX = 'webhook:secret:v2'

/** Encrypt under an arbitrary APP_KEY (encrypt() reads it from env) and context. */
function encryptUnder(appKey: string, plaintext: string, context?: string): string {
  const prev = process.env.APP_KEY
  process.env.APP_KEY = appKey
  try {
    return context === undefined ? encrypt(plaintext) : encrypt(plaintext, context)
  } finally {
    if (prev === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = prev
  }
}

test.group('classifySecretRotation', () => {
  test('encrypts a plaintext-era value (fail-closed reads need it ciphertext)', ({ assert }) => {
    assert.deepEqual(
      classifySecretRotation('raw-plaintext-secret', OLD_KEY, CURRENT_KEY, TARGET_CTX),
      {
        action: 'rotate',
        plaintext: 'raw-plaintext-secret',
      }
    )
  })

  test('rotates a value encrypted under the OLD key (default ctx), recovering the exact plaintext', ({
    assert,
  }) => {
    const stored = encryptUnder(OLD_KEY, 'whsec_super-secret-value')
    assert.deepEqual(classifySecretRotation(stored, OLD_KEY, CURRENT_KEY, TARGET_CTX), {
      action: 'rotate',
      plaintext: 'whsec_super-secret-value',
    })
  })

  test('migrates a value at the current key but the legacy default context', ({ assert }) => {
    const stored = encryptUnder(CURRENT_KEY, 'whsec_legacy-context')
    assert.deepEqual(classifySecretRotation(stored, OLD_KEY, CURRENT_KEY, TARGET_CTX), {
      action: 'rotate',
      plaintext: 'whsec_legacy-context',
    })
  })

  test('rotates a value at the OLD key but already the target context', ({ assert }) => {
    const stored = encryptUnder(OLD_KEY, 'whsec_old-key-target-ctx', TARGET_CTX)
    assert.deepEqual(classifySecretRotation(stored, OLD_KEY, CURRENT_KEY, TARGET_CTX), {
      action: 'rotate',
      plaintext: 'whsec_old-key-target-ctx',
    })
  })

  test('reports a value already at (current key, target context) as current (idempotent)', ({
    assert,
  }) => {
    const stored = encryptUnder(CURRENT_KEY, 'whsec_already-migrated', TARGET_CTX)
    assert.deepEqual(classifySecretRotation(stored, OLD_KEY, CURRENT_KEY, TARGET_CTX), {
      action: 'current',
    })
  })

  test('context-only migration (oldKey === currentKey) still migrates the default context', ({
    assert,
  }) => {
    const stored = encryptUnder(CURRENT_KEY, 'whsec_ctx-only')
    assert.deepEqual(classifySecretRotation(stored, CURRENT_KEY, CURRENT_KEY, TARGET_CTX), {
      action: 'rotate',
      plaintext: 'whsec_ctx-only',
    })
  })

  test('fails a value that decrypts under neither key', ({ assert }) => {
    const stored = encryptUnder(THIRD_KEY, 'whsec_from-a-third-generation')
    assert.deepEqual(classifySecretRotation(stored, OLD_KEY, CURRENT_KEY, TARGET_CTX), {
      action: 'failed',
    })
  })

  test('fails a corrupted ciphertext rather than treating it as plaintext', ({ assert }) => {
    const stored = encryptUnder(OLD_KEY, 'whsec_value')
    // Flip the last ciphertext hex char so the GCM auth tag check fails.
    const corrupted = stored.slice(0, -1) + (stored.endsWith('a') ? 'b' : 'a')
    assert.deepEqual(classifySecretRotation(corrupted, OLD_KEY, CURRENT_KEY, TARGET_CTX), {
      action: 'failed',
    })
  })

  test('fails an enc_v1 prefix with a malformed body', ({ assert }) => {
    assert.deepEqual(
      classifySecretRotation('enc_v1:not-a-valid-body', OLD_KEY, CURRENT_KEY, TARGET_CTX),
      { action: 'failed' }
    )
  })
})
