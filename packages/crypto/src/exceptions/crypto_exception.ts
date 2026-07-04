/** The crypto satellite error codes. Grows as vectors and failure modes are covered. */
export const CRYPTO_ERROR_CODES = [
  'dek_missing', // a read found no live DEK for (subject, category): never provisioned or shredded
  'dek_invalid', // an unwrapped DEK is not 32 bytes (a corrupt / wrong-provider wrap)
  'dek_conflict', // two live DEKs for one (subject, category) were attempted (partial UNIQUE, I10, T12)
  'keyprovider_missing', // no KeyProvider is registered for the configured name
  'index_key_unavailable', // the KeyProvider yields no blind-index key: fail closed, never a bare unkeyed hash (I5, T3)
  'no_tenant_scope', // EncryptedRepository was called with no active tenant scope: fail closed, never a cross-tenant DEK
  'tenant_scope_mismatch', // a raw-SQL query's tenant differs from the active tenancy scope (ContextSeal)
  'config_invalid', // a malformed `config.crypto` block
  'shred_refused', // governance absent, or the category is not erasable (legal hold): I7 fail-closed
  'shred_unaudited', // no WORM ledger, or the PENDING append failed before the delete: abort, nothing destroyed
  'shred_audit_unfinalized', // the COMMITTED mark failed after the delete: erasure done, a PENDING row remains (reported)
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
