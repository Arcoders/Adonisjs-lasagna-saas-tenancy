import { getConfig } from '../../../config.js'
import { isExpired, DEFAULT_SOFT_DELETE_RETENTION_DAYS } from '../../../utils/soft_delete.js'
import { applyFix } from '../apply_fix.js'
import type { TenantModelContract } from '../../../types/contracts.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

/**
 * Reconciles a tenant's two independent lifecycle axes — `status` and `deletedAt`
 * — which the code mutates separately with nothing else enforcing that they agree.
 * It flags three states:
 *   - `lifecycle_status_divergence` (warn, fixable): soft-deleted (`deletedAt` set)
 *     but `status` left non-deleted. The `--fix` reconciles `status` to `deleted`
 *     (a status write only — it never resurrects or drops anything).
 *   - `lifecycle_deleted_without_timestamp` (info): `status='deleted'` but no
 *     timestamp — ambiguous which axis is authoritative, so surface only.
 *   - `schema_retention_expired` (info): a soft-deleted tenant past its retention
 *     window whose schema is still physically present — surfaced so the operator
 *     runs `tenant:purge-expired`; the doctor never auto-drops a schema.
 *
 * All issues are tenant-scoped, so one tenant's lifecycle drift degrades the report
 * (HTTP 200) rather than failing the whole platform.
 */
const tenantLifecycleCheck: DoctorCheck = {
  name: 'tenant_lifecycle',
  description:
    'Reconciles the status/deletedAt lifecycle axes: flags divergence (fixable), deleted-without-timestamp, and retained schemas past their retention window.',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const issues: DiagnosisIssue[] = []
    const cfg = getConfig()
    const retentionDays = cfg.softDelete?.retentionDays ?? DEFAULT_SOFT_DELETE_RETENTION_DAYS

    // Deleted + past-window tenants whose schema might still exist; gathered so the
    // physical-schema probe runs once, and only when there is a candidate.
    const expiredDeleted: TenantModelContract[] = []

    for (const tenant of ctx.tenants) {
      const timestampSet = tenant.isDeleted // deletedAt != null
      const statusDeleted = tenant.status === 'deleted'

      // Divergence (Atlas Rent): timestamp set, status not 'deleted'. Reconcile the
      // status forward to 'deleted' — the timestamp is the stronger signal that a
      // delete happened.
      if (timestampSet && !statusDeleted) {
        const issue: DiagnosisIssue = {
          code: 'lifecycle_status_divergence',
          severity: 'warn',
          scope: 'tenant',
          message:
            `Tenant "${tenant.name}" is soft-deleted (deletedAt set) but status is ` +
            `"${tenant.status}" — the status/deletedAt lifecycle axes diverge`,
          tenantId: tenant.id,
          fixable: true,
          meta: { status: tenant.status },
        }
        if (ctx.attemptFix) {
          await applyFix(
            ctx,
            issue,
            async (fresh) => {
              // Re-confirm the divergence against the fresh row before writing.
              if (fresh.isDeleted && fresh.status !== 'deleted') {
                fresh.status = 'deleted'
                await fresh.save()
              }
            },
            {
              action: 'tenant:doctor:lifecycle_reconcile',
              // The target IS soft-deleted; that is the state we are reconciling,
              // so the default deleted-refusal must not apply here.
              allowDeleted: true,
              metadata: { from: tenant.status, to: 'deleted' },
            }
          )
        }
        issues.push(issue)
        continue
      }

      // Inverse: status 'deleted' with no timestamp. Which axis is authoritative is
      // ambiguous, so surface only (no auto-fix).
      if (statusDeleted && !timestampSet) {
        issues.push({
          code: 'lifecycle_deleted_without_timestamp',
          severity: 'info',
          scope: 'tenant',
          message:
            `Tenant "${tenant.name}" has status "deleted" but no deletedAt timestamp — ` +
            `ambiguous lifecycle state`,
          tenantId: tenant.id,
        })
        continue
      }

      if (timestampSet && isExpired(tenant.deletedAt, retentionDays)) {
        expiredDeleted.push(tenant)
      }
    }

    if (expiredDeleted.length > 0) {
      const db = await lazyDb()
      if (db) {
        const central = db.connection(cfg.centralConnectionName)
        const rows = await central.rawQuery(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE ?`,
          [`${cfg.tenantSchemaPrefix}%`]
        )
        const physical = new Set<string>(
          (rows.rows ?? rows ?? []).map((r: any) => r.schema_name as string)
        )
        for (const tenant of expiredDeleted) {
          if (physical.has(tenant.schemaName)) {
            issues.push({
              code: 'schema_retention_expired',
              severity: 'info',
              scope: 'tenant',
              message:
                `Tenant "${tenant.name}" was soft-deleted past the ${retentionDays}-day ` +
                `retention window but its schema "${tenant.schemaName}" still exists — ` +
                `reclaim it with tenant:purge-expired`,
              tenantId: tenant.id,
              meta: { schema: tenant.schemaName, retentionDays },
            })
          }
        }
      }
    }

    return issues
  },
}

export default tenantLifecycleCheck
