import db from '@adonisjs/lucid/services/db'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import AiAuditWriter, {
  auditChecksum,
  type AiAuditRow,
  type AuditDb,
} from '../../src/services/ai_audit_writer.js'

/**
 * Shared real-Postgres setup for the AI audit integration specs. The append-only
 * `backoffice.ai_audit_logs` table lives in the shared backoffice schema (created
 * by the kit bootstrap), but the kit does not run the satellite's migration, so
 * each spec provisions the table + the full trigger set inline in `group.setup`
 * and drops it in teardown. These specs self-skip when Postgres is unreachable and
 * run in CI. The writer targets the central connection (the backoffice schema
 * lives there and the writer's SQL is schema-qualified `backoffice.ai_audit_logs`).
 */

export function centralConn(): string {
  return getConfig().centralConnectionName
}

/** Rows from a Lucid rawQuery result (node-pg `{ rows }` or a bare array). */
export function rowsOfResult(res: unknown): Array<Record<string, unknown>> {
  const rows = (res as { rows?: unknown } | null)?.rows
  if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>
  return Array.isArray(res) ? (res as Array<Record<string, unknown>>) : []
}

const CREATE_TABLE = `
  CREATE TABLE backoffice.ai_audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    seq bigint NOT NULL,
    checksum char(64) NOT NULL,
    prev_checksum char(64),
    op text NOT NULL,
    outcome text NOT NULL,
    reason text,
    principal_hash char(64),
    source_hash char(64),
    provider text,
    model text,
    tokens integer NOT NULL DEFAULT 0,
    fragments integer NOT NULL DEFAULT 0,
    embeddings_count integer NOT NULL DEFAULT 0,
    dimension integer NOT NULL DEFAULT 0,
    match_count integer NOT NULL DEFAULT 0,
    idempotent_replay boolean NOT NULL DEFAULT false,
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, seq)
  )`

const TRIGGERS = [
  `CREATE OR REPLACE FUNCTION backoffice.ai_audit_logs_no_mutate()
   RETURNS TRIGGER AS $$
   BEGIN
     RAISE EXCEPTION 'ai_audit_logs is append-only; UPDATE/DELETE is forbidden'
       USING ERRCODE = 'insufficient_privilege';
   END;
   $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER ai_audit_logs_no_update BEFORE UPDATE ON backoffice.ai_audit_logs
   FOR EACH ROW EXECUTE FUNCTION backoffice.ai_audit_logs_no_mutate()`,
  `CREATE TRIGGER ai_audit_logs_no_delete BEFORE DELETE ON backoffice.ai_audit_logs
   FOR EACH ROW EXECUTE FUNCTION backoffice.ai_audit_logs_no_mutate()`,
  `CREATE TRIGGER ai_audit_logs_no_truncate BEFORE TRUNCATE ON backoffice.ai_audit_logs
   FOR EACH STATEMENT EXECUTE FUNCTION backoffice.ai_audit_logs_no_mutate()`,
]

type Client = ReturnType<typeof db.connection>

export async function dropAiAuditTable(client: Client): Promise<void> {
  await client.rawQuery('DROP TABLE IF EXISTS backoffice.ai_audit_logs CASCADE').catch(() => {})
  await client
    .rawQuery('DROP FUNCTION IF EXISTS backoffice.ai_audit_logs_no_mutate() CASCADE')
    .catch(() => {})
}

export async function createAiAuditTable(client: Client): Promise<void> {
  await dropAiAuditTable(client)
  await client.rawQuery(CREATE_TABLE)
  for (const sql of TRIGGERS) await client.rawQuery(sql)
}

/**
 * Provision the audit table and report readiness. Returns false (self-skip) when
 * Postgres or the backoffice schema is unavailable, true after the table + triggers
 * are created. Returns a cleanup thunk to drop the table.
 */
export async function setupRealAudit(): Promise<{ ready: boolean; cleanup: () => Promise<void> }> {
  const client = db.connection(centralConn())
  try {
    await client.rawQuery('SELECT 1')
    await createAiAuditTable(client)
  } catch {
    return { ready: false, cleanup: async () => {} }
  }
  return { ready: true, cleanup: async () => dropAiAuditTable(client) }
}

/** A real writer over the central connection, optionally scoped for the ContextSeal. */
export function realWriter(activeScope?: string): AiAuditWriter {
  return new AiAuditWriter({
    getDb: async () => db as unknown as AuditDb,
    connectionName: centralConn(),
    activeScopeTenantId: () => activeScope,
  })
}

/** A sample non-PII row for a tenant. */
export function auditRow(tenantId: string, over: Partial<AiAuditRow> = {}): AiAuditRow {
  return {
    tenantId,
    op: 'chat',
    outcome: 'completed',
    reason: null,
    principalHash: 'a'.repeat(64),
    sourceHash: null,
    provider: 'claude',
    model: 'claude-opus-4-8',
    tokens: 10,
    fragments: 2,
    embeddingsCount: 0,
    dimension: 0,
    matchCount: 0,
    idempotentReplay: false,
    occurredAt: '2026-07-03T12:00:00.000Z',
    ...over,
  }
}

export { auditChecksum }
