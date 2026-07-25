import { createHash } from 'node:crypto'
import type { WormLedgerWriter } from '@adonisjs-lasagna/saas-tenancy/internal'
import type { PendingShredEntry, ShredLedger, ShredLedgerEntry } from '../types/shred_ledger.js'

/** Hash a data-subject id to a non-PII digest for the WORM ledger (never the raw id). */
function hashSubject(subjectId: string): string {
  return createHash('sha256').update(subjectId, 'utf8').digest('hex')
}

/**
 * The crypto {@link ShredLedger}, backed by the shared core `WormLedgerWriter`.
 * Because the ledger is append-only (UPDATE/DELETE forbidden by DB triggers), the
 * two-phase shred records COMMITTED by appending a second row that references the
 * PENDING one, NEVER by mutating it. A crash between the two leaves a PENDING row
 * with no COMMITTED marker, which a reconciliation pass detects. The subject id is
 * hashed before it reaches the ledger, so the ledger stays non-PII: it can be kept
 * forever to reconcile the WORM ledger against the shred, and it leaks nothing.
 *
 * The writer is injected (not imported as a value here beyond its type), so this
 * adapter carries no eager-barrel dependency; the crypto provider builds the writer
 * from the app.booted-safe `@adonisjs-lasagna/saas-tenancy/internal` subpath (the
 * first-party home the writer moved to in the core surface freeze).
 */
export default class WormShredLedger implements ShredLedger {
  constructor(private readonly writer: WormLedgerWriter) {}

  async appendPending(entry: ShredLedgerEntry): Promise<PendingShredEntry> {
    const appended = await this.writer.append({
      tenantId: entry.tenantId,
      action: 'crypto:shred:pending',
      subjectHash: hashSubject(entry.subjectId),
      category: entry.category,
      reason: entry.reason ?? null,
      metadata: {},
      occurredAt: new Date().toISOString(),
    })
    // The PENDING seq is what the COMMITTED marker references for reconciliation.
    return { id: String(appended.seq), tenantId: entry.tenantId }
  }

  async markCommitted(pending: PendingShredEntry): Promise<void> {
    // Append-only: a COMMITTED marker referencing the PENDING seq, never an UPDATE.
    await this.writer.append({
      tenantId: pending.tenantId,
      action: 'crypto:shred:committed',
      subjectHash: null,
      category: null,
      reason: null,
      metadata: { refSeq: Number(pending.id) },
      occurredAt: new Date().toISOString(),
    })
  }
}
