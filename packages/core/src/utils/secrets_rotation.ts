import { decryptWithAppKey, isEncrypted } from './crypto.js'

/**
 * The decision for a single stored secret during a `tenant:secrets:reencrypt`
 * run. Kept pure so the branch selection (the part whose bug would silently skip
 * a recoverable secret or corrupt an unrecoverable one) is unit-testable without
 * a database.
 */
export type SecretRotation =
  | { action: 'rotate'; plaintext: string } // recovered plaintext; re-encrypt under (current key, target context)
  | { action: 'current' } // already at (current key, target context): idempotent skip
  | { action: 'failed' } // not recoverable under any known key/context combination

/**
 * Classify a stored secret for re-encryption to `(current key, target context)`.
 *
 * The migration is two-axis: an APP_KEY rotation (old key -> current key) AND the
 * move from the legacy shared default context to a per-class context. A stored
 * value may sit at any combination of those axes, or be a plaintext-era value.
 * We try the cheapest "already done" check first, then recover the plaintext from
 * whichever combination wrote it, newest-most-likely first:
 *
 *   1. (current key, target context)  -> already migrated, skip
 *   2. plaintext (no ciphertext prefix) -> recover as-is, encrypt it now
 *   3. (current key, default context)  -> context migration only
 *   4. (old key, target context)       -> key rotation only
 *   5. (old key, default context)      -> both axes
 *   else                               -> failed (wrong APP_KEY generation)
 *
 * `decryptWithAppKey` with no context argument uses the crypto default context,
 * so the legacy-context attempts pass no third argument. When no distinct old key
 * is supplied (a context-only migration), the caller passes the current key as
 * `oldKey`; the old-key attempts then harmlessly duplicate the current-key ones.
 */
export function classifySecretRotation(
  value: string,
  oldKey: string,
  currentKey: string,
  targetContext: string
): SecretRotation {
  if (isEncrypted(value)) {
    try {
      decryptWithAppKey(value, currentKey, targetContext)
      return { action: 'current' }
    } catch {
      // not yet at the target; fall through to recovery
    }
  } else {
    // Plaintext-era value: it IS its own plaintext. Under the fail-closed strict
    // read it would now be unusable, so encrypt it under the target context.
    return { action: 'rotate', plaintext: value }
  }

  const attempts: Array<() => string> = [
    () => decryptWithAppKey(value, currentKey), // current key, legacy default context
    () => decryptWithAppKey(value, oldKey, targetContext), // old key, target context
    () => decryptWithAppKey(value, oldKey), // old key, legacy default context
  ]
  for (const attempt of attempts) {
    try {
      return { action: 'rotate', plaintext: attempt() }
    } catch {
      // try the next combination
    }
  }
  return { action: 'failed' }
}
