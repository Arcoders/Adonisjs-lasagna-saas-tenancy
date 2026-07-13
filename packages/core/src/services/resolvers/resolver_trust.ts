import type { MultitenancyConfig } from '../../types/config.js'
import { builtInResolvers } from './builtins.js'
import type { ResolverTrust, TenantResolver } from './resolver.js'

/**
 * The ONE place the package classifies how spoofable each resolver in the
 * resolution path is. Both the membership-gate (IDOR) check and the host-trust
 * check read the {@link ResolverTrust} of the resolvers that actually run, so the
 * two hand-kept name sets they used to carry (`CLIENT_CONTROLLED`,
 * `HOST_STRATEGIES`) collapse into the single `trust` field a resolver declares —
 * a new built-in or a custom resolver is classified by construction, never by
 * remembering to append its name to a list in another file.
 */

/** True for a `{ name, resolve }` resolver instance (vs a bare string name). */
function isResolverInstance(value: unknown): value is TenantResolver {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TenantResolver).name === 'string' &&
    typeof (value as TenantResolver).resolve === 'function'
  )
}

/** Built-in name → declared trust. Built at import from the frozen built-in set. */
const BUILTIN_TRUST: ReadonlyMap<string, ResolverTrust> = new Map(
  builtInResolvers.map((r) => [r.name, r.trust ?? 'client'])
)

/**
 * The trust of one chain entry (a built-in name, a bare custom name, or an inline
 * instance). FAIL-SAFE: an undeclared or unclassifiable entry resolves to
 * `'client'` (the riskiest class), so a custom resolver with no `trust` trips the
 * IDOR nudge/hard-fail unless the host declares `trust: 'server'` (or wires a
 * gate). A bare name that is neither a built-in nor an inline instance is a
 * runtime-registered custom resolver we cannot classify from config alone, so it
 * too fails safe to `'client'`.
 */
export function entryTrust(
  config: MultitenancyConfig,
  entry: string | TenantResolver
): ResolverTrust {
  const name = isResolverInstance(entry) ? entry.name : entry
  // A built-in name wins, whether the entry is that bare name OR an inline
  // instance that happens to reuse it: `wireResolverChain` registers the
  // built-ins FIRST, so a same-named host instance is dropped and the BUILT-IN
  // actually runs. Classify by the resolver that runs, not by the shadowed
  // instance's declared trust — else a trust-less instance named `subdomain`
  // would run the host-based built-in yet escape the host-trust audit.
  const builtin = BUILTIN_TRUST.get(name)
  if (builtin) return builtin
  if (isResolverInstance(entry)) return entry.trust ?? 'client'
  const inline = [
    ...(config.resolvers ?? []),
    ...(config.resolverChain ?? []).filter(isResolverInstance),
  ].find((r) => r.name === name)
  return inline?.trust ?? 'client'
}

/**
 * The trust of every resolver in the resolution path: the configured
 * `resolverChain` when non-empty, otherwise the solitary `resolverStrategy` as a
 * one-element chain (mirroring `canonicalChainNames`). Both the membership-gate
 * and host-trust audits derive from this, so they agree on exactly which
 * resolvers run and how each is classified.
 */
export function chainTrusts(config: MultitenancyConfig): ResolverTrust[] {
  const chain =
    config.resolverChain && config.resolverChain.length > 0
      ? config.resolverChain
      : [config.resolverStrategy]
  return chain.map((entry) => entryTrust(config, entry))
}
