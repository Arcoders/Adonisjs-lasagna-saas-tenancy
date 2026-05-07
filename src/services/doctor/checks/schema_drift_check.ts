import { getConfig } from '../../../config.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const lazyDb = () =>
  import('@adonisjs/lucid/services/db')
    .then((m) => m.default)
    .catch(() => null)

const schemaDriftCheck: DoctorCheck = {
  name: 'schema_drift',
  description:
    'Compares tenants in the registry against PostgreSQL schemas; flags missing schemas and orphan ones.',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const db = await lazyDb()
    if (!db) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          message: '@adonisjs/lucid is not available; cannot inspect schemas',
        },
      ]
    }

    const cfg = getConfig()
    const central = db.connection(cfg.centralConnectionName)
    const prefix = cfg.tenantSchemaPrefix

    const rows = await central.rawQuery(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE ?`,
      [`${prefix}%`]
    )
    const physical = new Set<string>(
      (rows.rows ?? rows ?? []).map((r: any) => r.schema_name as string)
    )

    const issues: DiagnosisIssue[] = []
    const expected = new Set<string>()

    for (const tenant of ctx.tenants) {
      if (tenant.isDeleted) continue
      expected.add(tenant.schemaName)
      if (!physical.has(tenant.schemaName)) {
        issues.push({
          code: 'schema_missing',
          severity: 'error',
          message: `Tenant "${tenant.name}" registry says ${tenant.status} but schema "${tenant.schemaName}" is missing`,
          tenantId: tenant.id,
          meta: { schema: tenant.schemaName, status: tenant.status },
        })
      }
    }

    for (const schema of physical) {
      if (!expected.has(schema)) {
        issues.push({
          code: 'schema_orphan',
          severity: 'warn',
          message: `Orphan schema "${schema}" has no matching tenant in the registry`,
          meta: { schema },
        })
      }
    }

    return issues
  },
}

export default schemaDriftCheck
