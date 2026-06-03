import { DateTime } from 'luxon'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const STALL_MINUTES = 30

const provisioningStalledCheck: DoctorCheck = {
  name: 'provisioning_stalled',
  description: `Detects tenants stuck in 'provisioning' for more than ${STALL_MINUTES} minutes; with --fix, marks them as 'failed'.`,

  async run(ctx): Promise<DiagnosisIssue[]> {
    const issues: DiagnosisIssue[] = []
    const cutoff = DateTime.utc().minus({ minutes: STALL_MINUTES })

    for (const tenant of ctx.tenants) {
      if (!tenant.isProvisioning) continue
      const createdAt = tenant.createdAt
      if (!createdAt) continue
      if (createdAt > cutoff) continue

      const stalledFor = Math.floor(DateTime.utc().diff(createdAt, 'minutes').minutes)
      const issue: DiagnosisIssue = {
        code: 'provisioning_stalled',
        severity: 'error',
        message: `Tenant "${tenant.name}" stuck in provisioning for ${stalledFor} minute(s)`,
        tenantId: tenant.id,
        fixable: true,
        meta: { stalledMinutes: stalledFor, createdAt: createdAt.toISO() },
      }

      if (ctx.attemptFix) {
        try {
          tenant.status = 'failed'
          await tenant.save()
          issue.meta = { ...issue.meta, fixed: true }
        } catch (error: any) {
          issue.meta = { ...issue.meta, fixed: false, fixError: error?.message }
        }
      }

      issues.push(issue)
    }

    return issues
  },
}

export default provisioningStalledCheck
