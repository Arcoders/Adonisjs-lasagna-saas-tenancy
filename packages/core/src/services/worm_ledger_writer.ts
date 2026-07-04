import { createHash, randomUUID } from 'node:crypto'

/**
 * The shared append-only WORM ledger writer. A per-tenant sha256 hash chain in the
 * shared `backoffice` schema, keyed by a `tenant_id` column with
 * `UNIQUE(tenant_id, seq)`, generalized from the AI audit writer's proven pattern
 * so the platform has ONE hash-chain implementation, not a fork per satellite.
 *
 * It serializes each tenant's tail-read + insert under a transaction-scoped
 * advisory lock, computes `seq` + `checksum` (so tampering that slips past the DB
 * triggers still breaks the chain), and writes FAIL-CLOSED: a row that cannot land
 * throws, never a silent success. Because the row lives in `backoffice` and is
 * keyed by a `tenant_id` column, this never routes through `tableLocation`, so it
 * survives `tenant:purge-expired` and the tenant request role cannot DROP it.
 *
 * It stores NON-PII only: a one-way `subject_hash`, the governance `category`, the
 * `action`, a `reason`, and a non-PII `metadata` object. Callers that carry a data
 * subject hash it before appending. Stateful only through the injected db, so it
 * is a container singleton (never `new`-ed per request). The DB seam is injected so
 * this module never value-imports the eager `/services` barrel and stays safe in a
 * bare unit runner.
 */

/** The bare table name in the shared `backoffice` schema. */
export const WORM_LEDGER_TABLE = 'worm_ledger'
const WORM_LEDGER_LOCK_PREFIX = 'worm_ledger:'
const MAX_APPEND_ATTEMPTS = 3

/**
 * The persisted column order (single source of truth for the INSERT binding order
 * and a fake's readback). `created_at` is omitted: it defaults to `now()` at the
 * database and is not part of the chain.
 */
export const WORM_LEDGER_COLUMNS = [
  'id',
  'tenant_id',
  'seq',
  'checksum',
  'prev_checksum',
  'action',
  'subject_hash',
  'category',
  'reason',
  'metadata',
  'occurred_at',
] as const

/** The minimal Lucid query surface the writer uses (injected, barrel-free). */
export interface WormQueryClient {
  rawQuery(sql: string, bindings?: readonly unknown[]): Promise<unknown>
  transaction<T>(callback: (trx: WormQueryClient) => Promise<T>): Promise<T>
}

export interface WormDb {
  connection(name: string): WormQueryClient
}

/** The non-PII fields an event supplies. `subjectHash` is a one-way digest, never a raw subject. */
export interface WormLedgerRow {
  readonly tenantId: string
  /** The event kind, namespaced, e.g. 'crypto:shred:pending' | 'governance:consent:grant'. */
  readonly action: string
  /** A one-way hash of the data subject (non-PII), or null for a tenant-level event. */
  readonly subjectHash: string | null
  /** The governance category this event concerns, or null. */
  readonly category: string | null
  /** The legal basis / reason, for the audit trail, or null. */
  readonly reason: string | null
  /** Non-PII structured extras (counts, references). Canonicalized (sorted keys) in the checksum. */
  readonly metadata: Record<string, unknown>
  /** ISO event time, normalized into the checksum so it round-trips through timestamptz. */
  readonly occurredAt: string
}

/** A persisted ledger row: the input plus the chain fields the writer computed. */
export interface WormLedgerEntry extends WormLedgerRow {
  readonly id: string
  readonly seq: number
  readonly checksum: string
  readonly prevChecksum: string | null
}

/** Where a chain first fails a verification walk. */
export interface WormVerifyBreak {
  readonly tenantId: string
  readonly seq: number
  readonly reason: 'gap' | 'prev_link' | 'checksum'
}

export interface WormVerifyResult {
  readonly ok: boolean
  readonly checked: number
  readonly break?: WormVerifyBreak
}

/** A fail-closed write failure: the append could not land, so the caller must not proceed. */
export class WormLedgerWriteError extends Error {
  readonly code = 'E_WORM_LEDGER_WRITE_FAILED'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WormLedgerWriteError'
  }
}

/** A raw-SQL append whose tenant does not match the active tenancy scope (the ContextSeal). */
export class WormLedgerScopeError extends Error {
  readonly code = 'E_WORM_LEDGER_SCOPE_MISMATCH'
  constructor(message: string) {
    super(message)
    this.name = 'WormLedgerScopeError'
  }
}

export interface WormLedgerWriterDeps {
  /** Resolve the Lucid db manager, for the backoffice connection + raw queries. */
  getDb: () => Promise<WormDb>
  /** The backoffice connection name (the shared ledger schema lives there). */
  connectionName: string
  /**
   * The active tenancy scope id (the satellite ContextSeal). Raw queries bypass
   * the kernel ContextSeal, so the writer re-asserts the row tenant equals the
   * active scope. Absent, or returning undefined (a background job), trusts the
   * caller-supplied tenant.
   */
  activeScopeTenantId?: () => string | undefined
}

/** A stable JSON serialization with sorted keys, so jsonb key-reordering can't change the checksum. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

/**
 * The canonical serialization the checksum covers. An array (not an object) so
 * there is no key-order ambiguity, with every value coerced to a stable type so the
 * string is byte-identical whether built from an in-memory row (write) or a row read
 * back through timestamptz/jsonb columns (verify).
 */
export function canonicalWormFields(row: WormLedgerRow, seq: number): string {
  return JSON.stringify([
    row.tenantId,
    Number(seq),
    row.action,
    row.subjectHash ?? null,
    row.category ?? null,
    row.reason ?? null,
    stableStringify(row.metadata ?? {}),
    new Date(row.occurredAt).toISOString(),
  ])
}

/** The chain checksum: sha256 over the canonical fields linked to the previous checksum. */
export function wormChecksum(row: WormLedgerRow, seq: number, prevChecksum: string | null): string {
  return createHash('sha256')
    .update(canonicalWormFields(row, seq) + '\n' + (prevChecksum ?? ''), 'utf8')
    .digest('hex')
}

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>
  const rows = (res as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505'
}

/** Map a database row (snake_case, driver-typed) back to a {@link WormLedgerRow}. */
function rowFromDb(db: Record<string, unknown>): WormLedgerRow {
  const rawMeta = db.metadata
  const metadata =
    rawMeta && typeof rawMeta === 'object'
      ? (rawMeta as Record<string, unknown>)
      : typeof rawMeta === 'string'
        ? (JSON.parse(rawMeta) as Record<string, unknown>)
        : {}
  return {
    tenantId: String(db.tenant_id),
    action: String(db.action),
    subjectHash: (db.subject_hash ?? null) as string | null,
    category: (db.category ?? null) as string | null,
    reason: (db.reason ?? null) as string | null,
    metadata,
    occurredAt:
      db.occurred_at instanceof Date ? db.occurred_at.toISOString() : String(db.occurred_at),
  }
}

export default class WormLedgerWriter {
  constructor(private readonly deps: WormLedgerWriterDeps) {}

  /**
   * Append one row to the tenant's chain, fail-closed. Resolves to the persisted
   * entry (with the computed `seq`/`checksum`). Throws {@link WormLedgerWriteError}
   * on any write failure; the caller treats the throw as fail-closed.
   */
  async append(row: WormLedgerRow): Promise<WormLedgerEntry> {
    const active = this.deps.activeScopeTenantId?.()
    if (active !== undefined && active !== row.tenantId) {
      throw new WormLedgerScopeError(
        'Refusing a WORM ledger append: the row tenant does not match the active tenancy scope.'
      )
    }

    try {
      const db = await this.deps.getDb()
      const client = db.connection(this.deps.connectionName)
      return await this.#appendChained(client, row)
    } catch (error) {
      if (error instanceof WormLedgerScopeError) throw error
      throw new WormLedgerWriteError('The WORM ledger row could not be written.', { cause: error })
    }
  }

  /**
   * Re-walk the chain (per tenant when `tenantId` is given, else all tenants),
   * recomputing each checksum from the stored row and confirming the seq is
   * contiguous and the prev-link is intact. Returns the first break, if any. This
   * catches tampering that disabled the triggers, rewrote a row, and re-enabled them.
   */
  async verify(tenantId?: string): Promise<WormVerifyResult> {
    const db = await this.deps.getDb()
    const client = db.connection(this.deps.connectionName)
    const where = tenantId ? 'WHERE tenant_id = ?' : ''
    const bindings = tenantId ? [tenantId] : []
    // safe-sql: the column list is a fixed module constant; the optional tenant filter is a ? bind.
    const res = await client.rawQuery(
      `SELECT ${WORM_LEDGER_COLUMNS.join(', ')} FROM backoffice.${WORM_LEDGER_TABLE} ${where} ORDER BY tenant_id ASC, seq ASC`,
      bindings
    )
    const rows = rowsOf(res)

    let prevTenant: string | undefined
    let prevSeq = 0
    let prevChecksum: string | null = null
    let checked = 0
    for (const dbRow of rows) {
      const tid = String(dbRow.tenant_id)
      const seq = Number(dbRow.seq)
      if (tid !== prevTenant) {
        prevTenant = tid
        prevSeq = 0
        prevChecksum = null
      }
      if (seq !== prevSeq + 1) {
        return { ok: false, checked, break: { tenantId: tid, seq, reason: 'gap' } }
      }
      const storedPrev = (dbRow.prev_checksum ?? null) as string | null
      if (storedPrev !== prevChecksum) {
        return { ok: false, checked, break: { tenantId: tid, seq, reason: 'prev_link' } }
      }
      const recomputed = wormChecksum(rowFromDb(dbRow), seq, storedPrev)
      if (recomputed !== String(dbRow.checksum)) {
        return { ok: false, checked, break: { tenantId: tid, seq, reason: 'checksum' } }
      }
      prevSeq = seq
      prevChecksum = String(dbRow.checksum)
      checked++
    }
    return { ok: true, checked }
  }

  /** The advisory-locked, hash-chained INSERT, with a bounded retry on a seq unique-violation. */
  async #appendChained(client: WormQueryClient, row: WormLedgerRow): Promise<WormLedgerEntry> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
      try {
        return await client.transaction(async (trx) => {
          // Serialize only this tenant's tail-read + insert; released at commit.
          await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtext(?))', [
            `${WORM_LEDGER_LOCK_PREFIX}${row.tenantId}`,
          ])
          // safe-sql: the table is a fixed module constant; tenant_id is a ? bind.
          const tailRes = await trx.rawQuery(
            `SELECT seq, checksum FROM backoffice.${WORM_LEDGER_TABLE} WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1`,
            [row.tenantId]
          )
          const tail = rowsOf(tailRes)[0]
          const seq = Number(tail?.seq ?? 0) + 1
          const prevChecksum = (tail?.checksum ?? null) as string | null
          const checksum = wormChecksum(row, seq, prevChecksum)
          const entry: WormLedgerEntry = { ...row, id: randomUUID(), seq, checksum, prevChecksum }

          const values = entryColumns(entry)
          const placeholders = WORM_LEDGER_COLUMNS.map((c) =>
            c === 'metadata' ? '?::jsonb' : '?'
          ).join(', ')
          // safe-sql: the column list is a fixed module constant; every value is a ? bind (metadata cast ::jsonb).
          await trx.rawQuery(
            `INSERT INTO backoffice.${WORM_LEDGER_TABLE} (${WORM_LEDGER_COLUMNS.join(', ')}) VALUES (${placeholders})`,
            WORM_LEDGER_COLUMNS.map((col) => values[col])
          )
          return entry
        })
      } catch (error) {
        lastError = error
        // A seq collision means the advisory lock was bypassed (a replica, a missed
        // lock): re-read the tail and re-link rather than fail. The lock makes this
        // effectively unreachable; the retry keeps the chain gap-free.
        if (isUniqueViolation(error) && attempt < MAX_APPEND_ATTEMPTS) continue
        throw error
      }
    }
    throw lastError
  }
}

/** The persisted values keyed by column name, in a shape the INSERT binds by column order. */
function entryColumns(
  entry: WormLedgerEntry
): Record<(typeof WORM_LEDGER_COLUMNS)[number], unknown> {
  return {
    id: entry.id,
    tenant_id: entry.tenantId,
    seq: entry.seq,
    checksum: entry.checksum,
    prev_checksum: entry.prevChecksum,
    action: entry.action,
    subject_hash: entry.subjectHash,
    category: entry.category,
    reason: entry.reason,
    metadata: JSON.stringify(entry.metadata ?? {}),
    occurred_at: entry.occurredAt,
  }
}
