import type { MultitenancyConfig } from '../types/config.js'
import { chainTrusts } from '../services/resolvers/resolver_trust.js'

/**
 * True when the resolution path derives the tenant from the request HOST (a
 * `trust: 'host'` resolver — subdomain / custom domain). Under a permissive proxy
 * trust these read `X-Forwarded-Host`, which an upstream hop (or the client, if
 * no trusted proxy strips it) can set freely, so without a host allowlist a
 * request can be steered onto another tenant's host. Classified from each
 * resolver's declared `trust`, the same single source the membership-gate audit
 * reads, so the two agree on exactly which resolvers run.
 */
export function resolutionUsesHostStrategy(config: MultitenancyConfig): boolean {
  return chainTrusts(config).some((trust) => trust === 'host')
}

function hasExpectedHostSuffix(config: MultitenancyConfig): boolean {
  const suffix = config.resolver?.expectedHostSuffix
  if (Array.isArray(suffix)) return suffix.some((s) => typeof s === 'string' && s.length > 0)
  return typeof suffix === 'string' && suffix.length > 0
}

const HOST_TRUST_MESSAGE =
  'multitenancy: a host-based resolver strategy (subdomain/domain-or-subdomain) is configured ' +
  'without resolver.expectedHostSuffix. The tenant is then taken from the request host, which ' +
  'under a permissive proxy trust an X-Forwarded-Host can spoof — steering a request onto another ' +
  "tenant's host. Set resolver.expectedHostSuffix to your tenant host suffix(es) so off-allowlist " +
  'hosts are refused before resolution, and ensure X-Forwarded-Host is only trusted from a proxy ' +
  'you control. See the Security guide.'

/**
 * Returns the host-trust warning message when a host-based strategy runs with no
 * `expectedHostSuffix` allowlist; null when the posture is safe (allowlist set,
 * or no host strategy). Shared by the boot warning (non-production) and the
 * hard boot failure (production, raised from {@link assertConfigBounds}).
 */
export function hostTrustWarning(config: MultitenancyConfig): string | null {
  if (!resolutionUsesHostStrategy(config)) return null
  if (hasExpectedHostSuffix(config)) return null
  return HOST_TRUST_MESSAGE
}
