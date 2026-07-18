import { getConfig } from '../../../config.js'
import { applyHeal } from '../apply_fix.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

/**
 * Doctor diagnostic check that verifies migrations have run for every active OR
 * suspended tenant schema. For each it queries `information_schema.tables` on the
 * central connection to confirm an `adonis_schema` table exists, reporting a
 * tenant-scoped error (fixable → heal provisions if needed and migrates) when
 * migrations never ran and a warning when the schema could not be inspected.
 * Suspended tenants are included so a tenant behind on migrations is caught before
 * it is reactivated. Returns a single error when `@adonisjs/lucid` is unavailable.
 *
 * @remarks Implements the DoctorCheck contract under the stable name `migration_state`.
 */
const migrationStateCheck: DoctorCheck = {
  name: 'migration_state',
  description:
    'Checks every active/suspended tenant schema for an `adonis_schema` table; missing means migrations never ran (fixable).',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const db = await lazyDb()
    if (!db) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          scope: 'platform',
          message: '@adonisjs/lucid is not available; cannot inspect migrations',
        },
      ]
    }

    const central = db.connection(getConfig().centralConnectionName)
    const issues: DiagnosisIssue[] = []

    for (const tenant of ctx.tenants) {
      // Include suspended: a suspended tenant behind on (or never given) migrations
      // must be caught before reactivation. Deleted/provisioning/failed are owned by
      // other checks.
      if (!tenant.isActive && !tenant.isSuspended) continue

      try {
        const rows = await central.rawQuery(
          `SELECT 1 FROM information_schema.tables
            WHERE table_schema = ? AND table_name = 'adonis_schema'`,
          [tenant.schemaName]
        )
        const found = (rows.rows ?? rows ?? []).length > 0
        if (!found) {
          const issue: DiagnosisIssue = {
            code: 'migrations_never_ran',
            severity: 'error',
            scope: 'tenant',
            message: `Tenant "${tenant.name}" (${tenant.status}) has no adonis_schema table — migrations never ran`,
            tenantId: tenant.id,
            fixable: true,
            meta: { schema: tenant.schemaName },
          }
          if (ctx.attemptFix) await applyHeal(issue)
          issues.push(issue)
        }
      } catch (error: any) {
        issues.push({
          code: 'migration_inspect_failed',
          severity: 'warn',
          scope: 'tenant',
          message: `Could not inspect migration state for "${tenant.name}": ${error?.message ?? 'unknown'}`,
          tenantId: tenant.id,
        })
      }
    }

    return issues
  },
}

export default migrationStateCheck
