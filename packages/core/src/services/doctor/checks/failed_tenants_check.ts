import type { DoctorCheck, DiagnosisIssue } from '../types.js'

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
