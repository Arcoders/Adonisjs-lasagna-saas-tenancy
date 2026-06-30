import type { MultitenancyConfig } from '../types/config.js'
import { membershipGateRisk } from '../services/membership_gate.js'
import { hostTrustWarning } from './assert_host_trust.js'

export type ResolutionRiskCode = 'membership_gate_missing' | 'host_trust_unbounded'

/**
 * One resolution-posture risk. Both codes are high-severity cross-tenant
 * exposures that depend only on configuration:
 *
 *  - `membership_gate_missing`: a client-controlled resolver strategy
 *    (header/path/request-data) with no `authorizeTenantAccess` gate, so any
 *    caller can swap the tenant id (IDOR).
 *  - `host_trust_unbounded`: a host-based strategy (subdomain/domain-or-subdomain)
 *    with no `resolver.expectedHostSuffix` allowlist, so a spoofed Host can steer
 *    a request onto another tenant.
 */
export interface ResolutionSafetyFinding {
  code: ResolutionRiskCode
  severity: 'high'
  message: string
}

/**
 * The single source of truth for resolution-posture risk. The boot warning
 * (dev), the `membership_gate` doctor check, and the production hard-fail in
 * `assertConfigBounds` all derive from this one function, so detection and
 * enforcement never drift apart.
 *
 * Acknowledgement is honored upstream, not re-checked here: `membershipGateRisk`
 * returns null when `authorizeTenantAccess` is wired OR
 * `acknowledgeNoMembershipGate` is set, so an accepted risk simply does not
 * appear as a finding (and therefore never warns or throws). Host-trust has no
 * acknowledgement affordance, so it always surfaces when the allowlist is unset.
 */
export function resolutionSafetyAudit(config: MultitenancyConfig): ResolutionSafetyFinding[] {
  const findings: ResolutionSafetyFinding[] = []

  const idor = membershipGateRisk(config)
  if (idor) findings.push({ code: 'membership_gate_missing', severity: 'high', message: idor })

  const host = hostTrustWarning(config)
  if (host) findings.push({ code: 'host_trust_unbounded', severity: 'high', message: host })

  return findings
}
