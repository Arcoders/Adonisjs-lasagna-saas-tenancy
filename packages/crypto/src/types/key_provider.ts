/**
 * The frozen key-hierarchy names. vault and governance reference these by name;
 * they are invariant-grade and do not change without a major bump.
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
  /** Which KEK generation wrapped this DEK (the rotation cursor). */
  readonly kekId: string
  /** The wrapped DEK bytes, provider-encoded. */
  readonly ciphertext: string
}

/**
 * The pluggable root-of-trust: yields a KEK and wraps/unwraps DEKs. It NEVER sees
 * plaintext field or blob data (it only ever handles the 32-byte DEK). The env
 * provider derives the KEK from `APP_KEY` (dev-grade); a prod provider is backed
 * by AWS KMS or HashiCorp Vault, so raw KEK bytes need never touch the app process.
 * Any HTTP-backed provider routes its outbound through core's `safeFetch`, so
 * crypto adds no second SSRF guard.
 */
export interface KeyProvider {
  /** 'env' | 'aws-kms' | 'hashicorp-vault' | a host-registered custom name. */
  readonly name: string
  /**
   * The crypto extension-contract generation this provider was built against
   * ({@link CRYPTO_CONTRACT_VERSION}). Checked at registration time by
   * `KeyProviderRegistry.register()` via `assertContractCompat`: a provider built
   * for a newer contract than this crypto build throws and fails closed; an older
   * or absent one registers with a one-time "unversioned" warning. Optional for
   * source compatibility, but every shipped or host provider should declare
   * `contractVersion = CRYPTO_CONTRACT_VERSION`. Mirrors `AIProviderContract`.
   */
  readonly contractVersion?: number
  /** Wrap (KEK-encrypt) a freshly generated 32-byte DEK for storage under the current KEK generation. */
  wrapDek(tenantId: string, dek: Buffer): Promise<WrappedDek>
  /**
   * Unwrap a stored {@link WrappedDek} back to the 32-byte DEK. Fail-closed:
   * throws on tamper or a wrong KEK. During a KEK rotation window a provider may
   * unwrap under either the current or a previous KEK generation it still holds
   * (the env provider reads `OLD_APP_KEY`, a KMS retains prior key versions), so a
   * value wrapped under an old generation keeps decrypting until it is re-wrapped.
   * This is unwrapping a DEK envelope, not a lenient field-value read: each attempt
   * is a strict open, and both failing throws.
   */
  unwrapDek(tenantId: string, wrapped: WrappedDek): Promise<Buffer>
  /**
   * The `kekId` of the current KEK generation for this tenant. It is the rotation
   * cursor `tenant:crypto:rekek` compares each wrapped-DEK row against to classify
   * it `current` (skip) versus `rewrap` without unwrapping, so a re-run is an
   * O(rows) idempotent cursor skip. Optional: a provider that cannot cheaply report
   * its current generation may omit it, in which case the rekek walker classifies
   * post-hoc. It re-wraps, then compares the fresh `kekId` to the row's; an
   * unchanged one was already current. A non-secret value: it is the same tag
   * stamped into every fresh {@link wrapDek} result.
   */
  currentKekId?(tenantId: string): Promise<string>
  /**
   * Derive the deterministic blind-index key for a `(tenant × category)`. Optional:
   * a provider that only wraps/unwraps DEKs may omit it, in which case blind
   * indexing is unavailable and `CryptoService.blindIndex` fails closed (a
   * brute-forceable unkeyed hash is never written in its place). This key is
   * emphatically NOT a DEK: it is stable across rows (so equal plaintexts index
   * equally), and it survives a crypto-shred, because the DEK is destroyed but
   * equality must still be computable for the rows that remain. It is held in the
   * KeyProvider so a DB dump alone cannot brute-force the HMAC. It must be at least
   * 32 bytes. The env provider derives it from `APP_KEY`; a KMS or Vault provider
   * returns a KMS-held key.
   */
  deriveIndexKey?(tenantId: string, category: CategoryKey): Promise<Buffer>
}
