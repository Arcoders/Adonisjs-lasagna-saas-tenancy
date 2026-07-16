import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import { qualifyBackofficeTable } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type { AiConfig } from '../define_config.js'
import type { AuditDb } from './ai_audit_writer.js'
import { AI_AUDIT_TABLE } from '../constants.js'

export interface AiAuditCheckDeps {
  /** The live `ai` config, read at run time so the check reflects the current posture. */
  getAiConfig: () => AiConfig | undefined
  /** Resolve the Lucid db manager (via the container `lucid.db` alias), so this stays free of a direct lucid import. */
  getDb: () => Promise<AuditDb>
  /** The backoffice connection name the audit table lives on. */
  connectionName: string
  /** The backoffice SCHEMA name (`config.backofficeSchemaName`), so the probe honors a renamed schema. */
  schemaName: string
}

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>
  const rows = (res as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
}

/**
 * The `ai_audit` doctor check (WS-AI-7). Audit is fail-closed and on by default,
 * so a host that enables the AI satellite but forgets to run `migration:run` (the
 * satellite publishes the audit migration on configure) would see every AI request
 * 503 at runtime. This surfaces that early, at `tenant:doctor` time:
 *
 *   1. The append-only `backoffice.ai_audit_logs` table exists. Missing => an
 *      error (AI requests fail-closed until it is migrated).
 *   2. The app database role is NOT a superuser: the DB triggers reject
 *      UPDATE/DELETE/TRUNCATE regardless of role, but a superuser could DROP them,
 *      so a superuser app role is a warning (serve requests least-privilege).
 *
 * Returns nothing when audit is disabled (`config.ai.audit.enabled === false`) or
 * `config.ai` is absent. Config + db are injected, so it unit-tests without an app.
 */
export function aiAuditCheck(deps: AiAuditCheckDeps): DoctorCheck {
  return {
    name: 'ai_audit',
    description:
      'Verifies the append-only AI audit table exists (audit is fail-closed) and that the app ' +
      'role is not a superuser (it could drop the append-only triggers).',

    async run(): Promise<DiagnosisIssue[]> {
      const ai = deps.getAiConfig()
      if (!ai || ai.audit?.enabled === false) return []

      let conn
      try {
        const db = await deps.getDb()
        conn = db.connection(deps.connectionName)
      } catch (error) {
        return [
          {
            code: 'ai_audit_db_unavailable',
            severity: 'warn',
            message: `could not resolve the "${deps.connectionName}" connection to probe the AI audit table: ${(error as Error).message}`,
          },
        ]
      }

      const issues: DiagnosisIssue[] = []

      const auditTable = qualifyBackofficeTable(deps.schemaName, AI_AUDIT_TABLE)
      const reg = rowsOf(await conn.rawQuery('SELECT to_regclass(?) AS reg', [auditTable]))
      if (!reg[0]?.reg) {
        issues.push({
          code: 'ai_audit_table_missing',
          severity: 'error',
          message:
            `the append-only AI audit table ${auditTable} is missing. AI audit is ` +
            'fail-closed, so AI requests will 503 until it is created: run `node ace migration:run` ' +
            '(the satellite publishes the migration on configure).',
        })
      }

      const su = rowsOf(
        await conn.rawQuery('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
      )
      if (su[0]?.rolsuper === true) {
        issues.push({
          code: 'app_role_superuser',
          severity: 'warn',
          message:
            'the app database role is a SUPERUSER, so it could DROP the append-only audit triggers. ' +
            'Serve requests under a least-privilege role and provision under a separate connection.',
        })
      }

      return issues
    },
  }
}
