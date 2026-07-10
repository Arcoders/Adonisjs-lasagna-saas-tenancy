import type { MultitenancyConfig } from '../types/config.js'

/**
 * Strategies where the tenant id arrives in attacker-controllable request data
 * (a header, a URL path segment, or a query/body field) rather than from DNS or
 * the host (subdomain / custom domain). With a client-controlled strategy a
 * swapped tenant id is a textbook cross-tenant IDOR unless an app-layer
 * membership check rejects the principal, which is exactly what
 * `authorizeTenantAccess` is for.
 */
const CLIENT_CONTROLLED: ReadonlySet<string> = new Set(['header', 'path', 'request-data'])

export function isClientControlledStrategy(strategy: string): boolean {
  return CLIENT_CONTROLLED.has(strategy)
}

/**
 * True when the resolution path (chain if set, else the single strategy) routes
 * through at least one client-controlled built-in. The chain holds resolver
 * names; the built-in names match the strategy names, so the same set applies.
 * Unknown custom resolver names are treated as not-client-controlled here (we
 * cannot classify a host's own resolver), so this never raises a false alarm on
 * a bespoke server-side resolver.
 */
export function resolutionIsClientControlled(config: MultitenancyConfig): boolean {
  const chain =
    config.resolverChain && config.resolverChain.length > 0
      ? config.resolverChain
      : [config.resolverStrategy]
  return chain.some((name) => typeof name === 'string' && isClientControlledStrategy(name))
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
