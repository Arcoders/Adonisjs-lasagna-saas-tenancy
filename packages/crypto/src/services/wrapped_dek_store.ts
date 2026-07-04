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

/**
 * The persistence seam for the per-tenant wrapped-DEK table. Injected into
 * {@link ../services/crypto_service.js CryptoService} so the service is testable
 * without a database (an in-memory double proves the round-trip) and the real
 * placement lives behind {@link ./pg_wrapped_dek_store.js}. Only the LIVE
 * (non-shredded) row is ever resolved for a read/write; a shred tombstone is
 * excluded by the partial UNIQUE (I10, §6.3). The shred + rotation methods land
 * in later phases.
 */
export interface WrappedDekStore {
  /** The live (non-shredded) wrapped-DEK row for (subject, category), or null. */
  findLive(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<WrappedDekRow | null>

  /**
   * Insert a fresh live wrapped-DEK row and return it (with its generated id).
   * Fail-closed on a duplicate live (subject, category): the partial UNIQUE makes
   * the live DEK singular (I10, T12), so a racing second provision throws rather
   * than splitting the ciphertext across two DEKs.
   */
  insert(tenant: TenantModelContract, row: NewWrappedDekRow): Promise<WrappedDekRow>
}
