import type { CategoryKey, SubjectId } from '../types/key_provider.js'

/**
 * Fired after a COMMITTED crypto-shred (crypto §7). It carries the tenant, the
 * subject, the category, and when it happened, so a host listener can react to
 * the erasure (drop caches, null a blind-index column, notify). It NEVER carries
 * the destroyed key or the erased content. The WORM ledger append on the shred
 * path is the audit mechanism (a direct fail-closed writer call); this event is a
 * host-facing notification, not the audit.
 */
export interface SubjectShreddedEvent {
  readonly tenantId: string
  readonly subjectId: SubjectId
  readonly category: CategoryKey
  readonly occurredAt: Date
}
