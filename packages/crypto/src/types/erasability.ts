import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { CategoryKey, SubjectId } from './key_provider.js'

/**
 * Governance's erasability verdict for a `(subject × category)` at shred time.
 * crypto consults this; it never decides erasability itself.
 */
export interface ErasabilityVerdict {
  /** True only if governance says this category is erasable for this subject right now. */
  readonly erasable: boolean
  /**
   * The legal basis / reason, carried into the refusal message and the audit
   * (e.g. 'consent', 'legal-obligation'). For a refused shred this is why it was
   * kept.
   */
  readonly reason?: string
  /**
   * When a `legal-obligation` category becomes erasable, for the honest
   * "retained until" report (never surfaced as "erased").
   */
  readonly retentionUntil?: Date | null
}

/**
 * The governance erasability gate crypto consults before a shred. Present when
 * governance is installed (wired via `config.crypto.erasabilityResolver`). crypto
 * NEVER decides erasability itself: when this resolver is absent, or cannot resolve
 * a basis, the shred of that category is refused, never defaulted to erase. It
 * fails closed. Destroying a `legal-obligation` record within retention is an
 * irreversible violation in the other direction, so under-erasing (retry later) is
 * always preferred to over-erasing.
 */
export type ErasabilityResolver = (
  tenant: TenantModelContract,
  subjectId: SubjectId,
  category: CategoryKey
) => Promise<ErasabilityVerdict> | ErasabilityVerdict
