import type { MultitenancyConfig } from '../types/config.js'
import { chainTrusts, entryTrust } from './resolvers/resolver_trust.js'

/**
 * A strategy is client-controlled when its tenant id arrives in
 * attacker-controllable request data (a header, a URL path segment, or a
 * query/body field) rather than from DNS or a server-side lookup. With a
 * client-controlled strategy a swapped tenant id is a textbook cross-tenant IDOR
 * unless an app-layer membership check rejects the principal, which is exactly
 * what `authorizeTenantAccess` is for. Classification reads the resolver's
 * declared {@link ResolverTrust}; an unknown/undeclared name FAILS SAFE to
 * client-controlled (see {@link entryTrust}), so a bespoke resolver with no
 * `trust` is flagged rather than silently trusted.
 */
export function isClientControlledStrategy(strategy: string): boolean {
  return entryTrust({} as MultitenancyConfig, strategy) === 'client'
}

/**
 * True when the resolution path (chain if set, else the single strategy) routes
 * through at least one client-controlled resolver, classified by each resolver's
 * declared `trust` (fail-safe to client for an undeclared/custom one).
 */
export function resolutionIsClientControlled(config: MultitenancyConfig): boolean {
  return chainTrusts(config).some((trust) => trust === 'client')
}

const IDOR_MESSAGE =
  'multitenancy: tenant resolution is client-controlled (header/path/request-data) but no ' +
  'membership gate is wired. config.authorizeTenantAccess is unset, so the package serves any ' +
  'tenant id the caller supplies — a swapped id is a cross-tenant IDOR. Wire authorizeTenantAccess ' +
  '(it returns false/throws => 403) or, if an equivalent app-layer guard already verifies the ' +
  'principal belongs to the resolved tenant, set acknowledgeNoMembershipGate=true to silence this. ' +
  'See the Security guide.'

/**
 * Returns the IDOR warning message when the deployment is exposed to the
 * cross-tenant access described in the security guide: a client-controlled
 * resolution strategy with neither the package membership gate
 * (`authorizeTenantAccess`) nor an explicit `acknowledgeNoMembershipGate`.
 * Returns null when the posture is safe (server-controlled resolution, a wired
 * hook, or a deliberate acknowledgement). Shared by the boot-time warning and
 * the `membership_gate` doctor check so both speak with one voice.
 */
export function membershipGateRisk(config: MultitenancyConfig): string | null {
  if (typeof config.authorizeTenantAccess === 'function') return null
  if (config.acknowledgeNoMembershipGate === true) return null
  if (!resolutionIsClientControlled(config)) return null
  return IDOR_MESSAGE
}
