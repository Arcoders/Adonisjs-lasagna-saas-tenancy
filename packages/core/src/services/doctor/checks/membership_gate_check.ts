import { getConfig } from '../../../config.js'
import { membershipGateRisk } from '../../membership_gate.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

/**
 * Surfaces the cross-tenant IDOR posture as an operational warning, not just a
 * boot-time log line that scrolls past: a client-controlled resolver strategy
 * (header/path/request-data) with no `authorizeTenantAccess` and no explicit
 * acknowledgement means any caller can swap the tenant id. `tenant:doctor`
 * reports it so it shows up in CI/health sweeps. Shares its verdict with the
 * boot warning via {@link membershipGateRisk}.
 */
const membershipGateCheck: DoctorCheck = {
  name: 'membership_gate',
  description: 'Flags a client-controlled resolver strategy with no tenant membership gate.',

  run(): DiagnosisIssue[] {
    const reason = membershipGateRisk(getConfig())
    if (!reason) return []
    return [
      {
        code: 'membership_gate_missing',
        severity: 'warn' as const,
        message: reason,
      },
    ]
  },
}

export default membershipGateCheck
