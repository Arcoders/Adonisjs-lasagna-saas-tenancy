import CryptoException from '../exceptions/crypto_exception.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { CategoryKey, SubjectId } from '../types/key_provider.js'
import type { BlindIndexOptions } from '../internal/blind_index.js'
import type CryptoService from './crypto_service.js'
import type { ShredResult } from './crypto_service.js'

export interface EncryptedRepositoryDeps {
  /** The field-encryption engine this repository is a context-aware facade over. */
  readonly crypto: CryptoService
  /**
   * Resolve the CURRENT request's tenant at call time (not construction time), so
   * one singleton repository serves every tenant. Wired to `tenancy.current()` in
   * the provider. Returns null when there is no active tenant scope, which the
   * repository turns into a fail-closed refusal (never a cross-tenant DEK).
   */
  readonly resolveCurrentTenant: () => Promise<TenantModelContract | null>
}

/**
 * The explicit, auditable field-encryption surface (crypto §6.4, Option B). It is
 * a thin, context-aware facade over {@link CryptoService}: it resolves the current
 * tenant from the active scope so the caller passes only the `(subject, category)`
 * and the value, and the encryption boundary stays a VISIBLE call in the code path
 * (the reviewer sees `repo.encrypt(...)` in the diff), unlike the `@encrypted`
 * decorator which hides it in a model hook. Both surfaces are backstopped by the
 * same invariants (I3 fail-closed reads/writes, I5 keyed blind index); the choice
 * is ergonomics vs explicitness, not safety.
 *
 * Every method is fail-closed: with no active tenant scope it THROWS
 * `no_tenant_scope` rather than guessing a tenant, so a DEK is never resolved or
 * destroyed under the wrong tenant. Stateless beyond the injected engine, so it is
 * a container singleton resolved via `container.make` (bound as both the class and
 * the `'crypto.repository'` alias), never `new`-ed per request.
 */
export default class EncryptedRepository {
  readonly #crypto: CryptoService
  readonly #resolveCurrentTenant: () => Promise<TenantModelContract | null>

  constructor(deps: EncryptedRepositoryDeps) {
    this.#crypto = deps.crypto
    this.#resolveCurrentTenant = deps.resolveCurrentTenant
  }

  /**
   * Encrypt a value under the current tenant's `(subject × category)` DEK,
   * provisioning the DEK on first write. Returns an enc_v2 ciphertext the caller
   * stores in its own column; a later crypto-shred of that DEK makes it
   * irrecoverable (I6).
   */
  async encrypt(subject: SubjectId, category: CategoryKey, value: string): Promise<string> {
    return this.#crypto.encryptField(await this.#tenant(), subject, category, value)
  }

  /**
   * Decrypt a value under the current tenant's `(subject × category)` DEK.
   * Fail-closed (I3, T6): a shredded / never-provisioned DEK, a non-enc_v2 value,
   * or a tamper throws rather than returning plaintext.
   */
  async decrypt(subject: SubjectId, category: CategoryKey, ciphertext: string): Promise<string> {
    return this.#crypto.decryptField(await this.#tenant(), subject, category, ciphertext)
  }

  /**
   * Build the deterministic blind index (a keyed HMAC) for equality search on a
   * low-entropy field (§6.5, I5). The caller stores this in its own index column on
   * write and queries `WHERE <col> = :index` on read (crypto owns the keyed HMAC,
   * the host owns the column). The index is category-level and does NOT touch the
   * DEK, so it survives a crypto-shred (T14). DOCUMENTED leak: a DB reader sees
   * which rows share a value and how often (I5, T4).
   */
  async blindIndex(
    category: CategoryKey,
    value: string,
    options: BlindIndexOptions = {}
  ): Promise<string> {
    return this.#crypto.blindIndex(await this.#tenant(), category, value, options)
  }

  /**
   * Crypto-shred the current tenant's `(subject × category)`: the O(1) erasure
   * (I6, §6.6). Gated by governance's erasability resolver (I7) and audited by the
   * two-phase WORM ledger; refuses fail-closed when the category is not erasable or
   * no ledger is wired. Does NOT null the host's blind-index column (T14, §6.5).
   */
  async shred(subject: SubjectId, category: CategoryKey): Promise<ShredResult> {
    return this.#crypto.shred(await this.#tenant(), subject, category)
  }

  /** Resolve the active tenant, or refuse fail-closed when there is no scope. */
  async #tenant(): Promise<TenantModelContract> {
    const tenant = await this.#resolveCurrentTenant()
    if (!tenant) {
      throw new CryptoException(
        'no_tenant_scope',
        '[crypto] EncryptedRepository was called with no active tenant scope; a DEK is scoped per tenant and is never resolved under a guessed one. Call it inside the tenant request lifecycle (or a `tenancy.run(tenant, ...)` block).'
      )
    }
    return tenant
  }
}
