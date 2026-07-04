/**
 * The per-tenant wrapped-DEK table (crypto ARCHITECTURE.md §6.3, foundation §2.3).
 * It is placed by `driver.tableLocation(tenant)`, NEVER a hardcoded `tenant_<id>`
 * schema, so it lands in whatever placement the active isolation driver reports.
 */
export const CRYPTO_WRAPPED_DEKS_TABLE = 'crypto_wrapped_deks'

/**
 * The default KeyProvider backend for a fresh install: env-derived, dev-grade
 * (crypto §12.1). The KEK is deterministically derived from `APP_KEY`, so it
 * gives key-DESTRUCTION granularity (crypto-shred works) but NOT root-of-trust
 * SEPARATION (the honest limit, §10). Prod must bind a real KMS / HashiCorp Vault
 * provider.
 */
export const DEFAULT_KEY_PROVIDER = 'env'

/** A DEK is a raw AES-256 key: exactly 32 bytes. */
export const DEK_BYTES = 32
