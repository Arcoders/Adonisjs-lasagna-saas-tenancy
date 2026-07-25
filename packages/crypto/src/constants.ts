/**
 * The per-tenant wrapped-DEK table. It is placed by `driver.tableLocation(tenant)`,
 * NEVER a hardcoded `tenant_<id>` schema, so it lands in whatever placement the
 * active isolation driver reports.
 */
export const CRYPTO_WRAPPED_DEKS_TABLE = 'crypto_wrapped_deks'

/**
 * The default KeyProvider backend for a fresh install: env-derived and dev-grade.
 * The KEK is deterministically derived from `APP_KEY`, so it gives key-destruction
 * granularity (crypto-shred works) but NOT root-of-trust separation (the honest
 * limit). Prod must bind a real KMS or HashiCorp Vault provider.
 */
export const DEFAULT_KEY_PROVIDER = 'env'

/** A DEK is a raw AES-256 key: exactly 32 bytes. */
export const DEK_BYTES = 32

/**
 * A blind-index key is an HMAC-SHA256 key: 32 bytes. It is a distinct KeyProvider
 * capability, NOT a DEK: it survives a crypto-shred (equality must stay computable
 * for surviving rows) and is stable across rows (equal plaintexts index equally).
 * The `blindIndex` seam refuses an index key shorter than this rather than write a
 * weakly-keyed HMAC.
 */
export const INDEX_KEY_BYTES = 32
