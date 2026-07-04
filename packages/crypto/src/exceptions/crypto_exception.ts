/** The crypto satellite error codes. Grows as vectors and failure modes are covered. */
export const CRYPTO_ERROR_CODES = [
  'dek_missing', // a read found no live DEK for (subject, category): never provisioned or shredded
  'dek_invalid', // an unwrapped DEK is not 32 bytes (a corrupt / wrong-provider wrap)
  'dek_conflict', // two live DEKs for one (subject, category) were attempted (partial UNIQUE, I10, T12)
  'keyprovider_missing', // no KeyProvider is registered for the configured name
  'tenant_scope_mismatch', // a raw-SQL query's tenant differs from the active tenancy scope (ContextSeal)
  'rowscope_unsupported', // the wrapped-DEK table under rowscope needs a scope column (a follow-up placement)
  'config_invalid', // a malformed `config.crypto` block
] as const

export type CryptoErrorCode = (typeof CRYPTO_ERROR_CODES)[number]

/**
 * A crypto-satellite failure. Every security-relevant path is fail-closed
 * (foundation §9): a read that cannot be decrypted, or a write that would store
 * cleartext, THROWS one of these rather than degrading to plaintext. The
 * per-guard isthmus registry (ARCHITECTURE §7) lands in a later phase; today the
 * code carries the reason.
 */
export default class CryptoException extends Error {
  constructor(
    readonly code: CryptoErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CryptoException'
  }
}
