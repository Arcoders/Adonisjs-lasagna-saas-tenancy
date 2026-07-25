import CryptoException from './exceptions/crypto_exception.js'
import { emitCryptoGuardEvent } from './isthmus/crypto_guard_audit.js'
import type { CryptoConfig } from './define_config.js'

/**
 * Validate the `config.crypto` block eagerly at boot so a malformed shape fails
 * fast (the `assertConfigBounds` pattern), not at the first encrypted write. A
 * missing block is fine (the satellite is simply inert); a present block must
 * carry a non-empty `keyProvider` name if it sets one, and well-formed field
 * entries.
 */
export function assertCryptoConfig(crypto: CryptoConfig | undefined): void {
  if (crypto === undefined) return

  if (crypto.keyProvider !== undefined) {
    if (typeof crypto.keyProvider !== 'string' || crypto.keyProvider.trim() === '') {
      emitCryptoGuardEvent('guard.crypto_config_invalid')
      throw new CryptoException(
        'config_invalid',
        '[crypto] config.crypto.keyProvider must be a non-empty backend name (e.g. "env", "aws-kms").'
      )
    }
  }

  if (crypto.fields !== undefined) {
    for (const [label, field] of Object.entries(crypto.fields)) {
      if (!field || typeof field.category !== 'string' || field.category.trim() === '') {
        emitCryptoGuardEvent('guard.crypto_config_invalid')
        throw new CryptoException(
          'config_invalid',
          `[crypto] config.crypto.fields['${label}'] must declare a non-empty category.`
        )
      }
    }
  }
}
