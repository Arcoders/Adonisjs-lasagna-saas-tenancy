import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { CategoryKey, SubjectId } from '../types/key_provider.js'

/** A persisted wrapped-DEK row (crypto §6.3). Holds the DEK ONLY wrapped (I2). */
export interface WrappedDekRow {
  /** Row id (uuid). Doubles as the non-secret `keyId` tag stamped into a sealed value. */
  readonly id: string
  readonly subjectId: SubjectId
  readonly category: CategoryKey
  /** The `WrappedDek.ciphertext` (KEK-encrypted DEK). Never a plaintext DEK. */
  readonly wrappedDek: string
  /** The `WrappedDek.kekId` (rotation cursor). */
  readonly kekId: string
  /** Null while the DEK is live; set at the instant it is shredded (tombstone). */
  readonly shreddedAt: Date | null
}

/** The fields provided when provisioning a fresh live DEK row. */
export interface NewWrappedDekRow {
  readonly subjectId: SubjectId
  readonly category: CategoryKey
  readonly wrappedDek: string
  readonly kekId: string
}

/** Keyset-pagination options for {@link WrappedDekStore.listLive} (the rekek walk). */
export interface ListLiveOptions {
  /** Only rows whose `id` sorts strictly after this cursor (ordered by `id` asc). */
  readonly afterId?: string
  /** Page size; the walker loops until a short page. */
  readonly limit?: number
}

/**
 * The persistence seam for the per-tenant wrapped-DEK table. Injected into
 * {@link ../services/crypto_service.js CryptoService} so the service is testable
 * without a database (an in-memory double proves the round-trip) and the real
 * placement lives behind {@link ./pg_wrapped_dek_store.js}. Only the LIVE
 * (non-shredded) row is ever resolved for a read/write; a shred tombstone is
 * excluded by the partial UNIQUE (I10, §6.3).
 */
export interface WrappedDekStore {
  /** The live (non-shredded) wrapped-DEK row for (subject, category), or null. */
  findLive(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<WrappedDekRow | null>

  /**
   * A keyset-paginated page of the tenant's LIVE (non-shredded) wrapped-DEK rows,
   * ordered by `id` ascending, for the KEK-rotation walk (`tenant:crypto:rekek`,
   * I8, §6.7). Shredded tombstones are excluded (they hold no key to re-wrap). The
   * cursor is keyset (`id > afterId`), not OFFSET, so the walk is bounded-memory
   * and stable under a concurrent re-wrap (a re-wrap keeps the row's `id`, so the
   * cursor never skips or double-visits a row).
   */
  listLive(tenant: TenantModelContract, options?: ListLiveOptions): Promise<WrappedDekRow[]>

  /**
   * Insert a fresh live wrapped-DEK row and return it (with its generated id).
   * Fail-closed on a duplicate live (subject, category): the partial UNIQUE makes
   * the live DEK singular (I10, T12), so a racing second provision throws rather
   * than splitting the ciphertext across two DEKs.
   */
  insert(tenant: TenantModelContract, row: NewWrappedDekRow): Promise<WrappedDekRow>

  /**
   * Shred the live DEK for (subject, category): tombstone the row (set
   * `shredded_at` and null the `wrapped_dek`, destroying the ONLY copy of the
   * key). Returns true if a live row was shredded, false if there was none
   * (already shredded / never provisioned). Because the partial UNIQUE excludes
   * tombstones, a later legitimate re-provision can insert a fresh live row
   * (§6.3, decision 6).
   */
  shredLive(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<boolean>

  /**
   * Re-wrap a LIVE wrapped-DEK row: replace its `wrapped_dek` (KEK-encrypted DEK)
   * and `kek_id` (the rotation cursor) for the given row id. Used by the
   * KEK-rotation walker (I8, §6.7) after it unwraps the DEK under the old KEK and
   * re-wraps it under the current one. The DEK value itself is unchanged, so every
   * field ciphertext sealed under it keeps decrypting (the data is never
   * re-encrypted). Only a LIVE row is touched (`WHERE shredded_at IS NULL`), so a
   * row shredded concurrently between the scan and the re-wrap is a no-op (returns
   * false), never resurrecting destroyed key material. Returns true if a live row
   * was updated.
   */
  rewrap(
    tenant: TenantModelContract,
    id: string,
    wrappedDek: string,
    kekId: string
  ): Promise<boolean>
}
