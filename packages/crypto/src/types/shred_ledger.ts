import type { CategoryKey, SubjectId } from './key_provider.js'

/** The non-PII shred record appended to the WORM ledger (crypto §6.6). NEVER the destroyed key. */
export interface ShredLedgerEntry {
  readonly tenantId: string
  readonly subjectId: SubjectId
  readonly category: CategoryKey
  /** The erasability basis governance resolved (e.g. 'consent'), for the audit trail. */
  readonly reason?: string
}

/** A handle to a PENDING shred row, returned by {@link ShredLedger.appendPending}. */
export interface PendingShredEntry {
  readonly id: string
}

/**
 * The synchronous, fail-closed WORM-ledger append seam crypto calls on the shred
 * path (crypto §6.6, foundation §4). This is deliberately NOT an async event a
 * governance listener records after the fact: crypto AWAITS `appendPending`
 * BEFORE the irreversible delete and ABORTS the shred if it throws, so an
 * irreversible erasure is never run unaudited. The concrete implementation is the
 * shared `WormLedgerWriter` (generalized from `ai_audit_writer`) hosted in a
 * package at or below crypto, injected here so crypto imports it without a DAG
 * cycle. When it is ABSENT the shred is refused (an unaudited erasure is never
 * allowed).
 */
export interface ShredLedger {
  /**
   * Append a PENDING shred row (who, when, which `(subject × category)`, NOT the
   * key) BEFORE the delete. A throw aborts the shred (nothing is destroyed).
   */
  appendPending(entry: ShredLedgerEntry): Promise<PendingShredEntry>
  /**
   * Mark the PENDING row COMMITTED after the delete. A throw here leaves a
   * detectable PENDING row (the erasure IS recorded, just not finalized) that a
   * reconciliation pass resolves; it is reported, never a silent success.
   */
  markCommitted(pending: PendingShredEntry): Promise<void>
}
