import { getConfig } from '../../../config.js'
import { resolutionSafetyAudit } from '../../../providers/resolution_safety.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

/**
 * Surfaces the cross-tenant IDOR posture as an operational warning, not just a
 * boot-time log line that scrolls past: a client-controlled resolver strategy
 * (header/path/request-data) with no `authorizeTenantAccess` and no explicit
 * acknowledgement means any caller can swap the tenant id. `tenant:doctor`
 * reports it so it shows up in CI/health sweeps. Derives from the same
 * {@link resolutionSafetyAudit} that backs the boot warning and the production
 * hard-fail, so the three never disagree.
 */
const membershipGateCheck: DoctorCheck = {
  name: 'membership_gate',
  description: 'Flags a client-controlled resolver strategy with no tenant membership gate.',

  run(): DiagnosisIssue[] {
    return resolutionSafetyAudit(getConfig())
      .filter((risk) => risk.code === 'membership_gate_missing')
      .map((risk) => ({
        code: 'membership_gate_missing',
        severity: 'warn' as const,
        message: risk.message,
      }))
  },
}

export default membershipGateCheck
