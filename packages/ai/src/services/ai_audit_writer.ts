import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import AIException from '../exceptions/ai_exception.js'
import { AI_AUDIT_TABLE, AI_AUDIT_LOCK_PREFIX, AI_AUDIT_ANCHOR_TIMEOUT_MS } from '../constants.js'
import type { AuditLogEntry } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * The append-only AI audit writer (WS-AI-7, I5). Every chat / embedding /
 * retrieval choke point maps its frozen non-PII event onto an {@link AiAuditRow}
 * and hands it here. The writer serializes a per-tenant hash chain with a
 * transaction-scoped advisory lock, computes `seq`+`checksum` (so tampering that
 * slips past the DB triggers still breaks the chain), and writes the canonical row
 * FAIL-CLOSED: a write that cannot land emits `guard.ai_audit_write_failed` and
 * throws, never a silent success (the fail-closed matrix). The row lives in the
 * shared `backoffice` schema (it survives `tenant:purge-expired`, and the tenant
 * request role cannot DROP it), so this never routes through `tableLocation` and
 * needs no rowscope branch. Stateful only through the injected db, so it is a
 * container singleton (never `new`-ed per request).
 */

/** The minimal Lucid query surface the writer uses (injected, so it never value-imports the eager core barrel). */
export interface AuditQueryClient {
  rawQuery(sql: string, bindings?: readonly unknown[]): Promise<unknown>
  transaction<T>(callback: (trx: AuditQueryClient) => Promise<T>): Promise<T>
}

export interface AuditDb {
  connection(name: string): AuditQueryClient
}

/** One host audit destination (the kernel `AuditLogDestination` surface, narrowed). */
export interface AuditAnchorDestination {
  readonly name: string
  write(entry: AuditLogEntry): Promise<void> | void
}

/** The host audit destination registry (the kernel `AuditLogDestinationRegistry`, narrowed). */
export interface AuditAnchorRegistry {
  list(): readonly AuditAnchorDestination[]
}

export interface AiAuditWriterDeps {
  /** Resolve the Lucid db manager, for the backoffice connection + raw queries. */
  getDb: () => Promise<AuditDb>
  /** The backoffice connection name (the shared audit schema lives there). */
  connectionName: string
  /**
   * The active tenancy scope id (the satellite ContextSeal). Raw queries bypass
   * the kernel ContextSeal, so the writer re-asserts the row tenant equals the
   * active scope. Returns undefined when no scope is bound (a background job), in
   * which case the caller-supplied tenant is trusted.
   */
  activeScopeTenantId: () => string | undefined
  /**
   * External anchoring (WS-AI-7, #6): resolve the host's audit destination
   * registry so each committed row is fanned out to the operator's SIEM/WORM the
   * same way kernel audit is. Optional and injected (kept barrel-free), so a host
   * with no destinations pays nothing. Absent => no anchoring.
   */
  getDestinations?: () => Promise<AuditAnchorRegistry | undefined>
  /**
   * The bounded extension runner (the kernel `executeExtension`), injected so this
   * module never value-imports the eager core barrel. Used to time-bound each
   * destination write. Absent => no anchoring.
   */
  runExtension?: <T>(fn: () => Promise<T>, opts: { label: string; timeoutMs: number }) => Promise<T>
}

/**
 * The non-PII fields a choke point supplies (the union of the three frozen audit
 * events). Principal and source are one-way SHA-256 hashes; no prompt, response,
 * query, or document text is ever carried. Fields not applicable to an `op` take
 * a neutral default (0 / false / null).
 */
export interface AiAuditRow {
  readonly tenantId: string
  readonly op: 'chat' | 'embedding' | 'retrieval'
  readonly outcome: 'completed' | 'aborted' | 'failed_preflight'
  readonly reason: string | null
  readonly principalHash: string | null
  readonly sourceHash: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly tokens: number
  readonly fragments: number
  readonly embeddingsCount: number
  readonly dimension: number
  readonly matchCount: number
  readonly idempotentReplay: boolean
  /** ISO event time, normalized into the checksum so it round-trips through timestamptz. */
  readonly occurredAt: string
}

/** A persisted audit row: the input plus the chain fields the writer computed. */
export interface AiAuditEntry extends AiAuditRow {
  readonly id: string
  readonly seq: number
  readonly checksum: string
  readonly prevChecksum: string | null
}

/**
 * The persisted column order (single source of truth for the INSERT binding order
 * and the fake's readback). `created_at` is omitted: it defaults to `now()` at the
 * database and is not part of the chain.
 */
export const AI_AUDIT_COLUMNS = [
  'id',
  'tenant_id',
  'seq',
  'checksum',
  'prev_checksum',
  'op',
  'outcome',
  'reason',
  'principal_hash',
  'source_hash',
  'provider',
  'model',
  'tokens',
  'fragments',
  'embeddings_count',
  'dimension',
  'match_count',
  'idempotent_replay',
  'occurred_at',
] as const

const MAX_APPEND_ATTEMPTS = 3

/**
 * The canonical serialization the checksum covers. An array (not an object) so
 * there is no key-order ambiguity, with every value coerced to a stable type so
 * the string is byte-identical whether it is built from an in-memory row (write)
 * or a row read back through timestamptz/bigint columns (verify).
 */
export function canonicalAuditFields(row: AiAuditRow, seq: number): string {
  return JSON.stringify([
    row.tenantId,
    Number(seq),
    row.op,
    row.outcome,
    row.reason ?? null,
    row.principalHash ?? null,
    row.sourceHash ?? null,
    row.provider ?? null,
    row.model ?? null,
    Number(row.tokens) || 0,
    Number(row.fragments) || 0,
    Number(row.embeddingsCount) || 0,
    Number(row.dimension) || 0,
    Number(row.matchCount) || 0,
    Boolean(row.idempotentReplay),
    new Date(row.occurredAt).toISOString(),
  ])
}

/** The chain checksum: sha256 over the canonical fields linked to the previous checksum. */
export function auditChecksum(row: AiAuditRow, seq: number, prevChecksum: string | null): string {
  return createHash('sha256')
    .update(canonicalAuditFields(row, seq) + '\n' + (prevChecksum ?? ''), 'utf8')
    .digest('hex')
}

/** Where a chain first fails a verification walk. */
export interface AiAuditVerifyBreak {
  readonly tenantId: string
  readonly seq: number
  readonly reason: 'gap' | 'prev_link' | 'checksum'
}

export interface AiAuditVerifyResult {
  readonly ok: boolean
  readonly checked: number
  readonly break?: AiAuditVerifyBreak
}

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>
  const rows = (res as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505'
}

/** Map a database row (snake_case, driver-typed) back to an {@link AiAuditRow}. */
function rowFromDb(db: Record<string, unknown>): AiAuditRow {
  return {
    tenantId: String(db.tenant_id),
    op: db.op as AiAuditRow['op'],
    outcome: db.outcome as AiAuditRow['outcome'],
    reason: (db.reason ?? null) as string | null,
    principalHash: (db.principal_hash ?? null) as string | null,
    sourceHash: (db.source_hash ?? null) as string | null,
    provider: (db.provider ?? null) as string | null,
    model: (db.model ?? null) as string | null,
    tokens: Number(db.tokens ?? 0),
    fragments: Number(db.fragments ?? 0),
    embeddingsCount: Number(db.embeddings_count ?? 0),
    dimension: Number(db.dimension ?? 0),
    matchCount: Number(db.match_count ?? 0),
    idempotentReplay: db.idempotent_replay === true || db.idempotent_replay === 't',
    occurredAt:
      db.occurred_at instanceof Date ? db.occurred_at.toISOString() : String(db.occurred_at),
  }
}

export default class AiAuditWriter {
  constructor(private readonly deps: AiAuditWriterDeps) {}

  /**
   * Append one attributed row to the tenant's chain, fail-closed. Resolves to the
   * persisted entry (with the computed `seq`/`checksum`) so a caller can anchor or
   * inspect it. Throws `AIException('audit_write_failed')` (503) on any write
   * failure, after emitting `guard.ai_audit_write_failed`.
   */
  async append(row: AiAuditRow): Promise<AiAuditEntry> {
    const active = this.deps.activeScopeTenantId()
    if (active !== undefined && active !== row.tenantId) {
      emitAiGuardEvent('guard.ai_scope_mismatch', {
        tenantId: row.tenantId,
        metadata: { op: row.op },
      })
      throw new AIException(
        'tenant_scope_mismatch',
        'Refusing an AI audit write: the row tenant does not match the active tenancy scope.'
      )
    }

    const db = await this.deps.getDb()
    const client = db.connection(this.deps.connectionName)
    let entry: AiAuditEntry
    try {
      entry = await this.#appendChained(client, row)
    } catch (error) {
      if (error instanceof AIException) throw error
      emitAiGuardEvent('guard.ai_audit_write_failed', {
        tenantId: row.tenantId,
        metadata: { op: row.op },
      })
      throw new AIException(
        'audit_write_failed',
        'Refusing to complete the request: the AI audit row could not be written.',
        { cause: error }
      )
    }
    // The canonical row is committed. External anchoring is best-effort and MUST
    // NOT fail the request or re-trip the fail-closed guard (the row is durable).
    await this.#anchorSafe(entry)
    return entry
  }

  /**
   * Re-walk the chain (per tenant when `tenantId` is given, else all tenants),
   * recomputing each checksum from the stored row and confirming the seq is
   * contiguous and the prev-link is intact. Returns the first break, if any. This
   * catches tampering that disabled the triggers, rewrote a row, and re-enabled
   * them: the recomputed checksum no longer matches, or a deletion leaves a gap.
   */
  async verify(tenantId?: string): Promise<AiAuditVerifyResult> {
    const db = await this.deps.getDb()
    const client = db.connection(this.deps.connectionName)
    const where = tenantId ? 'WHERE tenant_id = ?' : ''
    const bindings = tenantId ? [tenantId] : []
    // safe-sql: the column list is a fixed module constant; the optional tenant filter is a ? bind.
    const res = await client.rawQuery(
      `SELECT ${AI_AUDIT_COLUMNS.join(', ')} FROM backoffice.${AI_AUDIT_TABLE} ${where} ORDER BY tenant_id ASC, seq ASC`,
      bindings
    )
    const rows = rowsOf(res)

    let prevTenant: string | undefined
    let prevSeq = 0
    let prevChecksum: string | null = null
    let checked = 0
    for (const db of rows) {
      const tid = String(db.tenant_id)
      const seq = Number(db.seq)
      if (tid !== prevTenant) {
        prevTenant = tid
        prevSeq = 0
        prevChecksum = null
      }
      if (seq !== prevSeq + 1) {
        return { ok: false, checked, break: { tenantId: tid, seq, reason: 'gap' } }
      }
      const storedPrev = (db.prev_checksum ?? null) as string | null
      if (storedPrev !== prevChecksum) {
        return { ok: false, checked, break: { tenantId: tid, seq, reason: 'prev_link' } }
      }
      const recomputed = auditChecksum(rowFromDb(db), seq, storedPrev)
      if (recomputed !== String(db.checksum)) {
        return { ok: false, checked, break: { tenantId: tid, seq, reason: 'checksum' } }
      }
      prevSeq = seq
      prevChecksum = String(db.checksum)
      checked++
    }
    return { ok: true, checked }
  }

  /** The advisory-locked, hash-chained INSERT, with a bounded retry on a seq unique-violation. */
  async #appendChained(client: AuditQueryClient, row: AiAuditRow): Promise<AiAuditEntry> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
      try {
        return await client.transaction(async (trx) => {
          // Serialize only this tenant's tail-read + insert; released at commit.
          await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtext(?))', [
            `${AI_AUDIT_LOCK_PREFIX}${row.tenantId}`,
          ])
          // safe-sql: the table is a fixed module constant; tenant_id is a ? bind.
          const tailRes = await trx.rawQuery(
            `SELECT seq, checksum FROM backoffice.${AI_AUDIT_TABLE} WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1`,
            [row.tenantId]
          )
          const tail = rowsOf(tailRes)[0]
          const seq = Number(tail?.seq ?? 0) + 1
          const prevChecksum = (tail?.checksum ?? null) as string | null
          const checksum = auditChecksum(row, seq, prevChecksum)
          const entry: AiAuditEntry = { ...row, id: randomUUID(), seq, checksum, prevChecksum }

          const values = entryColumns(entry)
          const placeholders = AI_AUDIT_COLUMNS.map(() => '?').join(', ')
          // safe-sql: the column list is a fixed module constant; every value is a ? bind.
          await trx.rawQuery(
            `INSERT INTO backoffice.${AI_AUDIT_TABLE} (${AI_AUDIT_COLUMNS.join(', ')}) VALUES (${placeholders})`,
            AI_AUDIT_COLUMNS.map((col) => values[col])
          )
          return entry
        })
      } catch (error) {
        lastError = error
        // A seq collision means the advisory lock was bypassed (a replica, a
        // missed lock): re-read the tail and re-link rather than fail. The lock
        // makes this effectively unreachable; the retry keeps the chain gap-free.
        if (isUniqueViolation(error) && attempt < MAX_APPEND_ATTEMPTS) continue
        throw error
      }
    }
    throw lastError
  }

  /** Anchor a committed row, never letting a broken destination touch the request. */
  async #anchorSafe(entry: AiAuditEntry): Promise<void> {
    try {
      await this.#anchor(entry)
    } catch {
      /* anchoring is best-effort: the canonical row already committed, so a
         resolution error or a throwing destination must never fail the request */
    }
  }

  /**
   * Fan the committed row out to every host audit destination (WS-AI-7, #6),
   * mapped onto the kernel `AuditLogEntry` shape so AI audit and kernel audit share
   * one SIEM/WORM stream. Each write is time-bounded and isolated (`allSettled`),
   * so a slow or throwing destination is contained. No destinations, or no
   * anchoring deps, costs nothing.
   */
  async #anchor(entry: AiAuditEntry): Promise<void> {
    const getDestinations = this.deps.getDestinations
    const run = this.deps.runExtension
    if (!getDestinations || !run) return
    const registry = await getDestinations()
    if (!registry) return
    const destinations = registry.list()
    if (destinations.length === 0) return

    const logEntry = toAuditLogEntry(entry)
    await Promise.allSettled(
      destinations.map((dest) =>
        run(() => Promise.resolve(dest.write(logEntry)), {
          label: `ai-audit:${dest.name}`,
          timeoutMs: AI_AUDIT_ANCHOR_TIMEOUT_MS,
        })
      )
    )
  }
}

/**
 * Map a persisted AI audit entry onto the kernel `AuditLogEntry` a destination
 * receives. The action namespaces the op (`ai:chat` / `ai:embedding` /
 * `ai:retrieval`); the AI-typed non-PII fields ride in `metadata`; `actorId` is
 * the one-way principal hash; `ipAddress` is null. No prompt/response/query/doc
 * content is ever present (it is not on the entry).
 */
function toAuditLogEntry(entry: AiAuditEntry): AuditLogEntry {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    actorType: 'system',
    actorId: entry.principalHash,
    action: `ai:${entry.op}`,
    metadata: {
      op: entry.op,
      outcome: entry.outcome,
      reason: entry.reason,
      provider: entry.provider,
      model: entry.model,
      tokens: entry.tokens,
      fragments: entry.fragments,
      embeddingsCount: entry.embeddingsCount,
      dimension: entry.dimension,
      matchCount: entry.matchCount,
      idempotentReplay: entry.idempotentReplay,
      sourceHash: entry.sourceHash,
      seq: entry.seq,
      checksum: entry.checksum,
    },
    ipAddress: null,
    createdAt: entry.occurredAt,
  }
}

/** The persisted values keyed by column name, in a shape the INSERT binds by column order. */
function entryColumns(entry: AiAuditEntry): Record<(typeof AI_AUDIT_COLUMNS)[number], unknown> {
  return {
    id: entry.id,
    tenant_id: entry.tenantId,
    seq: entry.seq,
    checksum: entry.checksum,
    prev_checksum: entry.prevChecksum,
    op: entry.op,
    outcome: entry.outcome,
    reason: entry.reason,
    principal_hash: entry.principalHash,
    source_hash: entry.sourceHash,
    provider: entry.provider,
    model: entry.model,
    tokens: entry.tokens,
    fragments: entry.fragments,
    embeddings_count: entry.embeddingsCount,
    dimension: entry.dimension,
    match_count: entry.matchCount,
    idempotent_replay: entry.idempotentReplay,
    occurred_at: entry.occurredAt,
  }
}
