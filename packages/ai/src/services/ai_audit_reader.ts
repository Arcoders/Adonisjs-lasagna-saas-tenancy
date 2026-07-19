import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import AIException from '../exceptions/ai_exception.js'
import { qualifyBackofficeTable } from '@adonisjs-lasagna/saas-tenancy/sdk'
import {
  AI_AUDIT_TABLE,
  AI_AUDIT_CHECKPOINT_TABLE,
  DEFAULT_AI_AUDIT_PAGE_SIZE,
  MAX_AI_AUDIT_PAGE_SIZE,
  MAX_AI_AUDIT_PAGE,
  DEFAULT_AI_AUDIT_EXPORT_BATCH_SIZE,
} from '../constants.js'
import {
  AI_AUDIT_COLUMNS,
  type AiAuditEntry,
  type AiAuditRow,
  type AiAuditCheckpoint,
  type AuditDb,
} from './ai_audit_writer.js'

/**
 * The read/query side of the AI audit trail (Wave 4). A SELECT-only companion to
 * {@link AiAuditWriter}, taking the SAME injected deps so it inherits the
 * qualified-table discipline (never a `'backoffice'` literal) and the
 * re-assert-before-raw-SQL ContextSeal backstop for free. It NEVER emits
 * INSERT/UPDATE/DELETE against the chain table `ai_audit_logs`; it reads rows,
 * streams exports in chain order, and reads/writes the ADDITIVE
 * `ai_audit_checkpoints` table (a consumption artifact, never a chained row).
 *
 * The one invariant this pillar holds above all: no consumption path ever rewrites a
 * `seq`, `checksum`, or `prev_checksum`. Rewriting a chained row is exactly the
 * tampering the chain exists to catch.
 */

/** The reader's injected deps: the same tenancy pair the writer takes. */
export interface AiAuditReaderDeps {
  getDb: () => Promise<AuditDb>
  connectionName: string
  schemaName: string
  activeScopeTenantId: () => string | undefined
}

/** All-optional, all `?`-bound filters over the audit chain. A caller queries by the one-way `principalHash`, never a raw principal. */
export interface AiAuditQueryFilter {
  readonly tenantId?: string
  readonly op?: AiAuditRow['op']
  readonly outcome?: AiAuditRow['outcome']
  readonly principalHash?: string
  /** Inclusive ISO 8601 lower bound on `occurred_at`. */
  readonly from?: string
  /** Inclusive ISO 8601 upper bound on `occurred_at`. */
  readonly to?: string
  /** 1-based page, clamped to {@link MAX_AI_AUDIT_PAGE} (the OFFSET-DoS ceiling). */
  readonly page?: number
  /** Rows per page, clamped to {@link MAX_AI_AUDIT_PAGE_SIZE}. */
  readonly limit?: number
}

export interface AiAuditQueryResult {
  readonly rows: AiAuditEntry[]
  readonly page: number
  readonly limit: number
}

/** The valid `op` values, so a bound filter is validated against the union before it reaches SQL. */
const AI_AUDIT_OPS: ReadonlySet<AiAuditRow['op']> = new Set([
  'chat',
  'embedding',
  'retrieval',
  'tool',
])
const AI_AUDIT_OUTCOMES: ReadonlySet<AiAuditRow['outcome']> = new Set([
  'completed',
  'aborted',
  'failed_preflight',
])

/** Clamp an untrusted integer into `[min, max]`, defaulting a non-integer (the pure.ts idiom). */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>
  const rows = (res as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
}

/** Map a snake_case db row back to a full {@link AiAuditEntry} (row fields + chain fields). */
function entryFromDb(db: Record<string, unknown>): AiAuditEntry {
  return {
    id: String(db.id),
    tenantId: String(db.tenant_id),
    seq: Number(db.seq),
    checksum: String(db.checksum),
    prevChecksum: (db.prev_checksum ?? null) as string | null,
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

export default class AiAuditReader {
  readonly #table: string
  readonly #checkpointTable: string

  constructor(private readonly deps: AiAuditReaderDeps) {
    this.#table = qualifyBackofficeTable(deps.schemaName, AI_AUDIT_TABLE)
    this.#checkpointTable = qualifyBackofficeTable(deps.schemaName, AI_AUDIT_CHECKPOINT_TABLE)
  }

  /**
   * Re-assert the active tenancy scope before any raw read (raw SQL bypasses the
   * kernel ContextSeal). Under a bound scope only a read of THAT tenant passes; an
   * all-tenants or cross-tenant read is reachable only with NO bound scope (the admin
   * gate path). A disagreement trips `guard.ai_scope_mismatch` and throws.
   */
  #assertScope(tenantId: string | undefined): void {
    const active = this.deps.activeScopeTenantId()
    if (active !== undefined && tenantId !== active) {
      emitAiGuardEvent('guard.ai_scope_mismatch', {
        tenantId: active,
        metadata: { op: 'audit_read' },
      })
      throw new AIException(
        'tenant_scope_mismatch',
        'Refusing an AI audit read: the requested tenant does not match the active tenancy scope.'
      )
    }
  }

  /**
   * Read one clamped page of the chain, SELECT-only, every filter `?`-bound. Ordered
   * `tenant_id ASC, seq ASC` (the verify order), so a reader can re-walk what it reads.
   * A malformed `op`/`outcome` filter is ignored (never concatenated), and a hostile
   * `principalHash` like `x' OR '1'='1` is a bound value, so it matches zero rows.
   */
  async query(filter: AiAuditQueryFilter = {}): Promise<AiAuditQueryResult> {
    this.#assertScope(filter.tenantId)
    const limit = clampInt(filter.limit, 1, MAX_AI_AUDIT_PAGE_SIZE, DEFAULT_AI_AUDIT_PAGE_SIZE)
    const page = clampInt(filter.page, 1, MAX_AI_AUDIT_PAGE, 1)
    const offset = (page - 1) * limit

    const { clauses, bindings } = this.#filterClauses(filter)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const db = await this.deps.getDb()
    const client = db.connection(this.deps.connectionName)
    // safe-sql: column list is a module constant; #table is qualified via qualifyBackofficeTable (validates the schema); every filter + LIMIT/OFFSET is a ? bind.
    const res = await client.rawQuery(
      `SELECT ${AI_AUDIT_COLUMNS.join(', ')} FROM ${this.#table} ${where} ` +
        `ORDER BY tenant_id ASC, seq ASC LIMIT ? OFFSET ?`,
      [...bindings, limit, offset]
    )
    return { rows: rowsOf(res).map(entryFromDb), page, limit }
  }

  /**
   * Stream the chain out in `(tenant_id, seq)` order for export (Wave 4, 3.2), pulling
   * KEYSET pages of {@link DEFAULT_AI_AUDIT_EXPORT_BATCH_SIZE} so an export of millions
   * of rows never buffers the whole table and never pays the O(n) OFFSET cost. Chain
   * order (not `created_at`) is load-bearing: only in `(tenant_id, seq)` order is the
   * exported file self-verifiable by an external re-walk. SELECT-only.
   */
  async *exportStream(
    filter: AiAuditQueryFilter = {},
    batchSize: number = DEFAULT_AI_AUDIT_EXPORT_BATCH_SIZE
  ): AsyncGenerator<AiAuditEntry[]> {
    this.#assertScope(filter.tenantId)
    const db = await this.deps.getDb()
    const client = db.connection(this.deps.connectionName)

    let lastTenant: string | null = null
    let lastSeq = 0
    for (;;) {
      const { clauses, bindings } = this.#filterClauses(filter)
      if (lastTenant !== null) {
        // Keyset cursor: strictly after the last row emitted, in chain order.
        clauses.push('(tenant_id, seq) > (?, ?)')
        bindings.push(lastTenant, lastSeq)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      // safe-sql: column list is a module constant; #table is qualified; every filter, the keyset cursor, and LIMIT are ? binds.
      const res = await client.rawQuery(
        `SELECT ${AI_AUDIT_COLUMNS.join(', ')} FROM ${this.#table} ${where} ` +
          `ORDER BY tenant_id ASC, seq ASC LIMIT ?`,
        [...bindings, batchSize]
      )
      const rows = rowsOf(res)
      if (rows.length === 0) return
      yield rows.map(entryFromDb)
      const last = rows[rows.length - 1]!
      lastTenant = String(last.tenant_id)
      lastSeq = Number(last.seq)
      if (rows.length < batchSize) return
    }
  }

  /** Read one tenant's retention checkpoint (the seed an incremental verify folds from), or undefined. */
  async readCheckpoint(tenantId: string): Promise<AiAuditCheckpoint | undefined> {
    const db = await this.deps.getDb()
    const client = db.connection(this.deps.connectionName)
    // safe-sql: #checkpointTable is qualified via qualifyBackofficeTable; tenant_id is a ? bind.
    const res = await client.rawQuery(
      `SELECT last_seq, last_checksum FROM ${this.#checkpointTable} WHERE tenant_id = ? LIMIT 1`,
      [tenantId]
    )
    const row = rowsOf(res)[0]
    if (!row) return undefined
    return { seq: Number(row.last_seq), checksum: String(row.last_checksum) }
  }

  /** Read every tenant's checkpoint as a lookup, so an all-tenants incremental verify can seed per boundary. */
  async readCheckpoints(): Promise<Map<string, AiAuditCheckpoint>> {
    const db = await this.deps.getDb()
    const client = db.connection(this.deps.connectionName)
    // safe-sql: #checkpointTable is qualified via qualifyBackofficeTable; no interpolated input.
    const res = await client.rawQuery(
      `SELECT tenant_id, last_seq, last_checksum FROM ${this.#checkpointTable}`
    )
    const map = new Map<string, AiAuditCheckpoint>()
    for (const row of rowsOf(res)) {
      map.set(String(row.tenant_id), {
        seq: Number(row.last_seq),
        checksum: String(row.last_checksum),
      })
    }
    return map
  }

  /**
   * Advance a tenant's retention checkpoint (Wave 4, 3.4), on the ADDITIVE checkpoint
   * table — never a chain row. Upsert-forward: a later archive run overwrites the
   * high-water mark. This is the ONLY write this reader performs, and it touches no
   * `ai_audit_logs` row, so the chain-mutation invariant holds.
   */
  async writeCheckpoint(tenantId: string, seq: number, checksum: string): Promise<void> {
    const db = await this.deps.getDb()
    const client = db.connection(this.deps.connectionName)
    // safe-sql: #checkpointTable is qualified via qualifyBackofficeTable; every value is a ? bind.
    await client.rawQuery(
      `INSERT INTO ${this.#checkpointTable} (tenant_id, last_seq, last_checksum, updated_at) ` +
        `VALUES (?, ?, ?, now()) ` +
        `ON CONFLICT (tenant_id) DO UPDATE SET last_seq = EXCLUDED.last_seq, ` +
        `last_checksum = EXCLUDED.last_checksum, updated_at = now()`,
      [tenantId, seq, checksum]
    )
  }

  /** Build the shared filter clauses + `?` bindings used by both `query` and `exportStream`. */
  #filterClauses(filter: AiAuditQueryFilter): { clauses: string[]; bindings: unknown[] } {
    const clauses: string[] = []
    const bindings: unknown[] = []
    if (filter.tenantId !== undefined) {
      clauses.push('tenant_id = ?')
      bindings.push(filter.tenantId)
    }
    // A malformed op/outcome is dropped, never concatenated — the union is closed.
    if (filter.op !== undefined && AI_AUDIT_OPS.has(filter.op)) {
      clauses.push('op = ?')
      bindings.push(filter.op)
    }
    if (filter.outcome !== undefined && AI_AUDIT_OUTCOMES.has(filter.outcome)) {
      clauses.push('outcome = ?')
      bindings.push(filter.outcome)
    }
    if (filter.principalHash !== undefined) {
      clauses.push('principal_hash = ?')
      bindings.push(filter.principalHash)
    }
    if (filter.from !== undefined) {
      clauses.push('occurred_at >= ?')
      bindings.push(filter.from)
    }
    if (filter.to !== undefined) {
      clauses.push('occurred_at <= ?')
      bindings.push(filter.to)
    }
    return { clauses, bindings }
  }
}
