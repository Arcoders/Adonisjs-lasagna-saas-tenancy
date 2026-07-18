import { DateTime } from 'luxon'
import { applyFix } from '../apply_fix.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const STALL_MINUTES = 30

/**
 * Doctor check that scans the tenants in scope and flags any that have been stuck in the
 * 'provisioning' state for longer than the 30 minute stall threshold, measured from their
 * creation time. Each stalled tenant produces an error-severity diagnosis issue carrying the
 * elapsed minutes and creation timestamp. When the run requests a fix, it sets the tenant
 * status to 'failed' and persists it, recording whether the repair succeeded in the issue meta.
 */
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
        scope: 'tenant',
        message: `Tenant "${tenant.name}" stuck in provisioning for ${stalledFor} minute(s)`,
        tenantId: tenant.id,
        fixable: true,
        meta: { stalledMinutes: stalledFor, createdAt: createdAt.toISO() },
      }

      if (ctx.attemptFix) {
        // Fresh re-read + guard + audit via the shared safe-fix envelope, so a
        // concurrent provision that just completed is not clobbered back to failed.
        await applyFix(
          ctx,
          issue,
          async (fresh) => {
            if (fresh.isProvisioning) {
              fresh.status = 'failed'
              await fresh.save()
            }
          },
          { action: 'tenant:doctor:provisioning_quarantine' }
        )
      }

      issues.push(issue)
    }

    return issues
  },
}

export default provisioningStalledCheck
