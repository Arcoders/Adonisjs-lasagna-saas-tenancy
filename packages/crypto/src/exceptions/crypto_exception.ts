/** The crypto satellite error codes. Grows as vectors and failure modes are covered. */
export const CRYPTO_ERROR_CODES = [
  'dek_missing', // a read found no live DEK for (subject, category): never provisioned or shredded
  'dek_invalid', // an unwrapped DEK is not 32 bytes (a corrupt or wrong-provider wrap)
  'dek_conflict', // two live DEKs for one (subject, category) were attempted (partial UNIQUE)
  'keyprovider_missing', // no KeyProvider is registered for the configured name
  'keyprovider_unavailable', // an HTTP-backed KeyProvider (KMS or Vault) backend is unreachable, blocked by the SSRF pin, or errored
  'index_key_unavailable', // the KeyProvider yields no blind-index key: fail closed, never a bare unkeyed hash
  'no_tenant_scope', // EncryptedRepository was called with no active tenant scope: fail closed, never a cross-tenant DEK
  'tenant_scope_mismatch', // a raw-SQL query's tenant differs from the active tenancy scope (ContextSeal)
  'config_invalid', // a malformed `config.crypto` block
  'shred_refused', // governance absent, or the category is not erasable (legal hold): fail-closed
  'shred_unaudited', // no WORM ledger, or the PENDING append failed before the delete: abort, nothing destroyed
  'shred_audit_unfinalized', // the COMMITTED mark failed after the delete: erasure done, a PENDING row remains (reported)
  'shred_in_progress', // another shred/provision holds the serialize lock and it could not be acquired in the wait window (retriable)
  'insert_failed', // a wrapped-DEK INSERT ... RETURNING produced no row (fail-closed rather than crashing on undefined)
  'framed_stream_invalid', // a framed enc_v2 stream envelope failed integrity: reorder, drop, duplicate, truncation, or cross-stream frame
] as const

export type CryptoErrorCode = (typeof CRYPTO_ERROR_CODES)[number]

/**
 * A crypto-satellite failure. Every security-relevant path is fail-closed: a read
 * that cannot be decrypted, or a write that would store cleartext, throws one of
 * these rather than degrading to plaintext. The code carries the reason; the
 * per-guard isthmus registry carries the guard evidence.
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
