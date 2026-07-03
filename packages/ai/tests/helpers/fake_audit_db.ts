import {
  AI_AUDIT_COLUMNS,
  type AuditDb,
  type AuditQueryClient,
  type AiAuditWriterDeps,
} from '../../src/services/ai_audit_writer.js'

export interface FakeAuditOptions {
  /** The active tenancy scope id (the ContextSeal). Default undefined (seal passes). */
  activeScope?: string
  /**
   * Inject INSERT failures: `'always'` throws a generic error every time;
   * `{ code, times }` throws that PG error code the first `times` inserts, then
   * succeeds (drives the 23505 retry).
   */
  failInsert?: 'always' | { code: string; times: number }
  /**
   * Rows the verify SELECT (`ORDER BY tenant_id, seq`) returns (snake_case db
   * rows). When omitted, verify returns the rows this fake has auto-tracked from
   * prior INSERTs, so a write-then-verify flow is self-consistent.
   */
  verifyRows?: Array<Record<string, unknown>>
}

export interface FakeAuditEnv {
  deps: AiAuditWriterDeps
  queries: Array<{ sql: string; bindings: readonly unknown[] }>
  connections: string[]
  /** The snake_case rows the writer INSERTed, in order (bindings mapped by AI_AUDIT_COLUMNS). */
  inserts: Array<Record<string, unknown>>
}

/**
 * A fake backoffice db for AiAuditWriter unit tests. It records every raw query,
 * answers the advisory lock / tail read / verify read / INSERT by SQL shape, and
 * auto-tracks inserted rows so the per-tenant tail read returns the tenant's last
 * chained row (seq + checksum). Failure injection drives the fail-closed and
 * unique-violation-retry paths without a real Postgres.
 */
export function fakeAuditEnv(opts: FakeAuditOptions = {}): FakeAuditEnv {
  const queries: FakeAuditEnv['queries'] = []
  const connections: string[] = []
  const inserts: FakeAuditEnv['inserts'] = []
  let insertFailures = 0

  const client: AuditQueryClient = {
    async rawQuery(sql, bindings = []) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), bindings })
      const s = sql.toLowerCase()
      if (s.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (s.includes('order by tenant_id')) {
        const all = opts.verifyRows ?? inserts
        const tid = bindings[0]
        return { rows: tid ? all.filter((r) => String(r.tenant_id) === String(tid)) : all }
      }
      if (s.includes('order by seq desc')) {
        const tid = String(bindings[0])
        const forTenant = inserts.filter((r) => String(r.tenant_id) === tid)
        const last = forTenant[forTenant.length - 1]
        return { rows: last ? [{ seq: last.seq, checksum: last.checksum }] : [] }
      }
      if (s.includes('insert into')) {
        if (opts.failInsert === 'always') throw new Error('audit db down')
        if (opts.failInsert && typeof opts.failInsert === 'object') {
          if (insertFailures < opts.failInsert.times) {
            insertFailures++
            throw Object.assign(new Error('duplicate key value'), { code: opts.failInsert.code })
          }
        }
        const row: Record<string, unknown> = {}
        AI_AUDIT_COLUMNS.forEach((col, i) => {
          row[col] = bindings[i]
        })
        inserts.push(row)
        return { rows: [] }
      }
      return { rows: [] }
    },
    async transaction(callback) {
      return callback(client)
    },
  }

  const db: AuditDb = {
    connection(name) {
      connections.push(name)
      return client
    },
  }

  const deps: AiAuditWriterDeps = {
    getDb: async () => db,
    connectionName: 'backoffice',
    activeScopeTenantId: () => opts.activeScope,
  }

  return { deps, queries, connections, inserts }
}

/** A sample non-PII audit row for writer specs. */
export function sampleAuditRow(
  over: Partial<import('../../src/services/ai_audit_writer.js').AiAuditRow> = {}
) {
  return {
    tenantId: 'tenant-1',
    op: 'chat' as const,
    outcome: 'completed' as const,
    reason: null,
    principalHash: 'a'.repeat(64),
    sourceHash: null,
    provider: 'claude',
    model: 'claude-opus-4-8',
    tokens: 42,
    fragments: 3,
    embeddingsCount: 0,
    dimension: 0,
    matchCount: 0,
    idempotentReplay: false,
    occurredAt: '2026-07-03T12:00:00.000Z',
    ...over,
  }
}
