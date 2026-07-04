/**
 * The frozen key-hierarchy names (crypto ARCHITECTURE.md §6.2, foundation §2.2).
 * vault and governance reference these by name; they are invariant-grade and do
 * not change without a major bump.
 */

/** A stable subject (data-subject) identifier within a tenant, e.g. a renter's id. */
export type SubjectId = string

/** A governance-declared processing category, e.g. 'identity-docs' | 'rental-contract' | 'marketing'. */
export type CategoryKey = string

/**
 * The KEK-encrypted DEK envelope persisted in the wrapped-DEK table. Opaque
 * outside the KeyProvider: only the provider that wrapped it can unwrap it.
 */
export interface WrappedDek {
  /** Which KEK generation wrapped this DEK (the rotation cursor, I8). */
  readonly kekId: string
  /** The wrapped DEK bytes, provider-encoded. */
  readonly ciphertext: string
}

/**
 * The pluggable root-of-trust: yields a KEK and wraps/unwraps DEKs. It NEVER sees
 * plaintext field/blob data (it only ever handles the 32-byte DEK). The env
 * provider derives the KEK from `APP_KEY` (dev-grade); a prod provider is backed
 * by AWS KMS or HashiCorp Vault, so raw KEK bytes need never touch the app process
 * (I2). Any HTTP-backed provider routes its outbound through core's `safeFetch`
 * (T13); crypto adds no second SSRF guard.
 */
export interface KeyProvider {
  /** 'env' | 'aws-kms' | 'hashicorp-vault' | a host-registered custom name. */
  readonly name: string
  /** Wrap (KEK-encrypt) a freshly generated 32-byte DEK for storage. */
  wrapDek(tenantId: string, dek: Buffer): Promise<WrappedDek>
  /** Unwrap a stored {@link WrappedDek} back to the 32-byte DEK. Fail-closed: throws on tamper / wrong KEK. */
  unwrapDek(tenantId: string, wrapped: WrappedDek): Promise<Buffer>
}
