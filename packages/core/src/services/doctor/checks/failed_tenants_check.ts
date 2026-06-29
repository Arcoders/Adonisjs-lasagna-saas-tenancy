import type { DoctorCheck, DiagnosisIssue } from '../types.js'

/**
 * Doctor check named `failed_tenants` that scans the tenants in scope for the current
 * diagnostic run and reports any whose status is failed. Its `run` method filters the
 * context tenants by their `isFailed` flag and emits one error-severity `tenant_failed`
 * diagnosis issue per failed tenant, carrying the tenant name in the message and its id.
 */
const failedTenantsCheck: DoctorCheck = {
  name: 'failed_tenants',
  description: 'Lists tenants whose status is `failed`.',

  run(ctx): DiagnosisIssue[] {
    return ctx.tenants
      .filter((t) => t.isFailed)
      .map((t) => ({
        code: 'tenant_failed',
        severity: 'error' as const,
        message: `Tenant "${t.name}" is in failed state`,
        tenantId: t.id,
      }))
  },
}

export default failedTenantsCheck
