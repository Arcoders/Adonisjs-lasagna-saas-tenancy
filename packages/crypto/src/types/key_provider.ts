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
  /** Wrap (KEK-encrypt) a freshly generated 32-byte DEK for storage under the CURRENT KEK generation. */
  wrapDek(tenantId: string, dek: Buffer): Promise<WrappedDek>
  /**
   * Unwrap a stored {@link WrappedDek} back to the 32-byte DEK. Fail-closed:
   * throws on tamper / wrong KEK. During a KEK rotation window a provider may
   * unwrap under either the current OR a previous KEK generation it still holds
   * (the env provider reads `OLD_APP_KEY`, a KMS retains prior key versions), so a
   * value wrapped under an old generation keeps decrypting until it is re-wrapped
   * (I8, §6.7). This is unwrapping a DEK ENVELOPE, not a lenient field-value read:
   * each attempt is a strict open, and both-fail throws.
   */
  unwrapDek(tenantId: string, wrapped: WrappedDek): Promise<Buffer>
  /**
   * The `kekId` of the CURRENT KEK generation for this tenant (§6.7). It is the
   * rotation cursor `tenant:crypto:rekek` compares each wrapped-DEK row against to
   * classify it `current` (skip) vs `rewrap` WITHOUT unwrapping, so a re-run is an
   * O(rows) idempotent cursor skip. OPTIONAL: a provider that cannot cheaply report
   * its current generation may omit it, in which case the rekek walker classifies
   * post-hoc (re-wrap, then compare the fresh `kekId` to the row's — an unchanged
   * one was already current). A non-secret value: it is the same tag stamped into
   * every fresh {@link wrapDek} result.
   */
  currentKekId?(tenantId: string): Promise<string>
  /**
   * Derive the deterministic blind-index key for a `(tenant × category)` (§6.5,
   * I5). OPTIONAL: a provider that only wraps/unwraps DEKs may omit it, in which
   * case blind indexing is unavailable and `CryptoService.blindIndex` fails closed
   * (a brute-forceable unkeyed hash is never written in its place, §9). This key is
   * emphatically NOT a DEK: it is stable across rows (so equal plaintexts index
   * equally), it SURVIVES a crypto-shred (the DEK is destroyed, but equality must
   * still be computable for surviving rows, T14), and it is held in the KeyProvider
   * so a DB dump alone cannot brute-force the HMAC (T3). It must be at least
   * 32 bytes. The env provider derives it from `APP_KEY`; a KMS/Vault provider
   * returns a KMS-held key.
   */
  deriveIndexKey?(tenantId: string, category: CategoryKey): Promise<Buffer>
}
