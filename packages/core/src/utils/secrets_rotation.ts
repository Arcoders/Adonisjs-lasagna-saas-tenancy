import { decryptWithAppKey, isEncrypted } from './crypto.js'

/**
 * The decision for a single stored secret during an APP_KEY rotation
 * (`tenant:secrets:reencrypt`). Kept pure so the branch selection — the part
 * whose bug would silently skip an old-key secret or corrupt an unrecoverable
 * one — is unit-testable without a database.
 */
export type SecretRotation =
  | { action: 'skip' } // plaintext-era value: nothing key-bound to rotate
  | { action: 'rotate'; plaintext: string } // decrypts under the OLD key, must be re-encrypted
  | { action: 'current' } // already under the CURRENT key (idempotent re-run / partial rotation)
  | { action: 'failed' } // decrypts under NEITHER key

/**
 * Classify a stored secret for rotation. Tries the OLD key first; on failure it
 * checks whether the value already uses the CURRENT key (so re-runs and
 * partially-rotated tables are idempotent); if neither key works the value
 * predates both generations and is reported as a failure rather than silently
 * dropped. A non-`enc_v1` value is plaintext-era and skipped.
 */
export function classifySecretRotation(
  value: string,
  oldKey: string,
  currentKey: string
): SecretRotation {
  if (!isEncrypted(value)) return { action: 'skip' }
  try {
    return { action: 'rotate', plaintext: decryptWithAppKey(value, oldKey) }
  } catch {
    try {
      decryptWithAppKey(value, currentKey)
      return { action: 'current' }
    } catch {
      return { action: 'failed' }
    }
  }
}
