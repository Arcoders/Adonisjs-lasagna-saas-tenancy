import { randomBytes } from 'node:crypto'
import { sealV2WithKey, openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'
import { DEK_BYTES } from '../constants.js'
import CryptoException from '../exceptions/crypto_exception.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { CategoryKey, KeyProvider, SubjectId } from '../types/key_provider.js'
import type { WrappedDekStore } from './wrapped_dek_store.js'

export interface CryptoServiceDeps {
  /** The resolved KeyProvider (the one named by `config.crypto.keyProvider`). */
  readonly keyProvider: KeyProvider
  /** The persistence seam for the per-tenant wrapped-DEK table. */
  readonly store: WrappedDekStore
  /** DEK generator; defaults to `randomBytes(32)`. Injectable for deterministic tests. */
  readonly generateDek?: () => Buffer
}

/**
 * The field-encryption core (crypto §6). It resolves the per-`(subject ×
 * category)` DEK from the wrapped-DEK store (provisioning one on first write),
 * unwraps it through the {@link KeyProvider}, and seals/opens the field value with
 * core's enc_v2 GCM primitive via the `sealV2WithKey`/`openV2WithKey` seam. Every
 * path is fail-closed (I3): a read whose DEK is gone (shredded / never
 * provisioned), or a value that is not enc_v2 ciphertext, THROWS rather than
 * returning plaintext. The DEK is the domain separator (I4/T7): a value sealed
 * under one category's DEK cannot open under another. Stateful only through the
 * injected store, so it is a container singleton (never `new`-ed per request).
 *
 * The shred (§6.6), the blind-index search HMAC (§6.5), the per-tenant operation
 * lock around provision (§6.6, I10), and the KEK-rotation walker (§6.7) land in
 * later phases; this is the encrypt/decrypt spine they build on.
 */
export default class CryptoService {
  readonly #keyProvider: KeyProvider
  readonly #store: WrappedDekStore
  readonly #generateDek: () => Buffer

  constructor(deps: CryptoServiceDeps) {
    this.#keyProvider = deps.keyProvider
    this.#store = deps.store
    this.#generateDek = deps.generateDek ?? (() => randomBytes(DEK_BYTES))
  }

  /**
   * Encrypt a field value under the `(subject × category)` DEK, provisioning the
   * DEK on first write. Returns an enc_v2 ciphertext sealed under that DEK, so a
   * later crypto-shred of the DEK makes it irrecoverable (I6).
   */
  async encryptField(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey,
    plaintext: string
  ): Promise<string> {
    const { dek, keyId } =
      (await this.#liveDek(tenant, subjectId, category)) ??
      (await this.#provisionDek(tenant, subjectId, category))
    return sealV2WithKey(plaintext, dek, keyId)
  }

  /**
   * Decrypt a field value under the `(subject × category)` DEK. Fail-closed: if
   * the DEK was never provisioned or has been shredded, THROWS `dek_missing`
   * (never returns plaintext); a value that is not enc_v2 ciphertext, or one that
   * fails the DEK/GCM check, throws via the strict open path (I3, T6).
   */
  async decryptField(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey,
    ciphertext: string
  ): Promise<string> {
    const live = await this.#liveDek(tenant, subjectId, category)
    if (!live) {
      throw new CryptoException(
        'dek_missing',
        `[crypto] no live DEK for subject '${subjectId}' / category '${category}': it was never provisioned or has been shredded.`
      )
    }
    return openV2WithKey(ciphertext, live.dek)
  }

  /** Resolve the live DEK for (subject, category), or null if none is provisioned. */
  async #liveDek(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<{ dek: Buffer; keyId: string } | null> {
    const row = await this.#store.findLive(tenant, subjectId, category)
    if (!row) return null
    const dek = await this.#keyProvider.unwrapDek(tenant.id, {
      kekId: row.kekId,
      ciphertext: row.wrappedDek,
    })
    this.#assertDek(dek)
    // The row id is the non-secret `keyId` tag stamped into the envelope, so a
    // read/rotation can tell which DEK sealed a value.
    return { dek, keyId: row.id }
  }

  /** Generate + wrap a fresh DEK and persist it as the live row for (subject, category). */
  async #provisionDek(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<{ dek: Buffer; keyId: string }> {
    const dek = this.#generateDek()
    this.#assertDek(dek)
    const wrapped = await this.#keyProvider.wrapDek(tenant.id, dek)
    const row = await this.#store.insert(tenant, {
      subjectId,
      category,
      wrappedDek: wrapped.ciphertext,
      kekId: wrapped.kekId,
    })
    return { dek, keyId: row.id }
  }

  #assertDek(dek: Buffer): void {
    if (dek.length !== DEK_BYTES) {
      throw new CryptoException(
        'dek_invalid',
        `[crypto] an unwrapped DEK must be ${DEK_BYTES} bytes, got ${dek.length}.`
      )
    }
  }
}
