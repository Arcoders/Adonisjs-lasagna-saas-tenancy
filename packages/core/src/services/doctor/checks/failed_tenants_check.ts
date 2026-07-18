import { applyHeal } from '../apply_fix.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

/**
 * Doctor check named `failed_tenants` that scans the tenants in scope for the current
 * diagnostic run and reports any whose status is failed as a tenant-scoped error. With
 * `--fix` it heals (recovers) each: `healTenant` re-provisions the storage if absent,
 * applies pending migrations, and on success returns the tenant to `active`. A heal that
 * fails leaves the tenant quarantined `failed` and records `meta.fixed=false`.
 */
const failedTenantsCheck: DoctorCheck = {
  name: 'failed_tenants',
  description: 'Lists tenants whose status is `failed`; with --fix, heals (recovers) each.',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const issues: DiagnosisIssue[] = []
    for (const tenant of ctx.tenants) {
      if (!tenant.isFailed) continue
      const issue: DiagnosisIssue = {
        code: 'tenant_failed',
        severity: 'error',
        scope: 'tenant',
        message: `Tenant "${tenant.name}" is in failed state`,
        tenantId: tenant.id,
        fixable: true,
      }
      if (ctx.attemptFix) await applyHeal(issue)
      issues.push(issue)
    }
    return issues
  },
}

export default failedTenantsCheck
