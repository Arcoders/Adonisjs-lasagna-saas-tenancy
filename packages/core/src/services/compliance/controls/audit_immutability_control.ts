import type { ComplianceControl } from '../types.js'

const TRIGGERS = [
  'tenant_audit_logs_no_update',
  'tenant_audit_logs_no_delete',
  'tenant_audit_logs_no_truncate',
]

/**
 * Are the append-only triggers actually installed on `backoffice.tenant_audit_logs`?
 * Joins the catalog by name (no `regclass` cast) so a missing table yields zero
 * rows instead of throwing — an absent audit satellite reads as action-needed.
 */
const auditImmutabilityControl: ComplianceControl = {
  id: 'audit-immutability',
  title: 'Append-only audit trail (immutable at the database level)',
  frameworks: [
    'soc2:CC7.2',
    'soc2:CC7.3',
    'gdpr:art30',
    'iso:A.8.15',
    'hipaa:164.312(b)',
    'hipaa:164.312(c)(1)',
  ],

  async detect({ config, db }) {
    const schema = config.backofficeSchemaName
    const conn = db.connection(config.backofficeConnectionName)
    // `nspname` is compared as a string value (not an identifier slot), so it
    // binds as a `?` parameter — and it MUST be the configured schema, not a
    // hardcoded 'backoffice', or a host that renamed the backoffice schema gets
    // a false "missing trigger" verdict on this compliance control.
    const result = await conn.rawQuery(
      `SELECT t.tgname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ?
          AND c.relname = 'tenant_audit_logs'
          AND t.tgname = ANY(?)`,
      [schema, TRIGGERS]
    )
    const rows: any[] = result.rows ?? result ?? []
    const found = new Set(rows.map((r) => r.tgname))
    const missing = TRIGGERS.filter((t) => !found.has(t))

    if (missing.length === 0) {
      return {
        status: 'satisfied',
        evidence:
          'All three BEFORE UPDATE/DELETE/TRUNCATE triggers are installed on ' +
          `${schema}.tenant_audit_logs; rows cannot be rewritten or erased by the app role.`,
        hostResponsibility:
          'Run audit-log retention under a separate privileged role (disable the trigger ' +
          'only inside a controlled window). Ship rows to a long-term store for archival.',
      }
    }

    return {
      status: 'action-needed',
      evidence: `Missing immutability trigger(s): ${missing.join(', ')}.`,
      hostResponsibility:
        'Decide whether the audit trail is in scope for your controls; if so, install it.',
      remediation:
        'node ace configure @adonisjs-lasagna/saas-tenancy --with=audit && node ace migration:run',
    }
  },
}

export default auditImmutabilityControl
