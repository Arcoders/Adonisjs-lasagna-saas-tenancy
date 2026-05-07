import { getConfig } from '../../../config.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const lazyDb = () =>
  import('@adonisjs/lucid/services/db')
    .then((m) => m.default)
    .catch(() => null)

const migrationStateCheck: DoctorCheck = {
  name: 'migration_state',
  description: 'Checks every tenant schema for an `adonis_schema` table; missing means migrations never ran.',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const db = await lazyDb()
    if (!db) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          message: '@adonisjs/lucid is not available; cannot inspect migrations',
        },
      ]
    }

    const central = db.connection(getConfig().centralConnectionName)
    const issues: DiagnosisIssue[] = []

    for (const tenant of ctx.tenants) {
      if (!tenant.isActive) continue

      try {
        const rows = await central.rawQuery(
          `SELECT 1 FROM information_schema.tables
            WHERE table_schema = ? AND table_name = 'adonis_schema'`,
          [tenant.schemaName]
        )
        const found = (rows.rows ?? rows ?? []).length > 0
        if (!found) {
          issues.push({
            code: 'migrations_never_ran',
            severity: 'error',
            message: `Active tenant "${tenant.name}" has no adonis_schema table — migrations never ran`,
            tenantId: tenant.id,
            meta: { schema: tenant.schemaName },
          })
        }
      } catch (error: any) {
        issues.push({
          code: 'migration_inspect_failed',
          severity: 'warn',
          message: `Could not inspect migration state for "${tenant.name}": ${error?.message ?? 'unknown'}`,
          tenantId: tenant.id,
        })
      }
    }

    return issues
  },
}

export default migrationStateCheck
