import type { MultitenancyConfig } from '../types/config.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'
import { builtInResolvers } from '../services/resolvers/index.js'
import TenantResolverRegistry from '../services/resolvers/registry.js'
import type { TenantResolver } from '../services/resolvers/resolver.js'

/** True for a `TenantResolver` instance (a `{ name, resolve }` object). */
export function isResolverInstance(value: unknown): value is TenantResolver {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TenantResolver).name === 'string' &&
    typeof (value as TenantResolver).resolve === 'function'
  )
}

/** Names known at config time: built-ins + inline instances (config.resolvers + chain instances). */
function knownResolverNames(config: MultitenancyConfig): Set<string> {
  const names = new Set<string>(builtInResolvers.map((r) => r.name))
  for (const r of config.resolvers ?? []) names.add(r.name)
  for (const entry of config.resolverChain ?? []) {
    if (isResolverInstance(entry)) names.add(entry.name)
  }
  return names
}

/**
 * The canonical resolver chain as a list of NAMES: the configured `resolverChain`
 * (each inline instance mapped to its `name`) when non-empty, otherwise the
 * solitary `resolverStrategy` as a one-element chain. This is the single place the
 * package answers "which resolvers run, in what order" — the boot wiring
 * ({@link wireResolverChain}) and the host-trust audit both read it, so a lone
 * `resolverStrategy` and an explicit `resolverChain` collapse to one shape and the
 * "no chain configured" branch never has to be re-derived per call site.
 */
export function canonicalChainNames(config: MultitenancyConfig): string[] {
  const chain = config.resolverChain
  if (chain && chain.length > 0) {
    return chain.map((entry) => (isResolverInstance(entry) ? entry.name : entry))
  }
  return [config.resolverStrategy]
}

/**
 * Config-level validation of `resolverChain`.
 * Every string entry must name a built-in or an inline instance the host
 * supplied (in `resolverChain` itself or `config.resolvers`). Throws a clear,
 * config-level error naming the offender and the valid options, instead of the
 * registry-internal "unknown resolver" message that `setChain` would raise later.
 * Pure, so it runs from `assertConfigBounds` and is unit-testable without a boot.
 */
export function assertResolverChain(config: MultitenancyConfig): void {
  const chain = config.resolverChain
  if (!chain || chain.length === 0) return
  const known = knownResolverNames(config)
  for (const entry of chain) {
    if (isResolverInstance(entry)) continue
    if (typeof entry !== 'string' || !known.has(entry)) {
      emitIsthmusEvent('guard.resolver_chain', {
        metadata: { entry: String(entry).slice(0, 64) },
      })
      throw new Error(
        `multitenancy.resolverChain references unknown resolver ${JSON.stringify(entry)}. ` +
          `Pass it as an inline TenantResolver (in resolverChain or config.resolvers), ` +
          `or use a built-in (${[...known].join(', ')}).`
      )
    }
  }
}

/**
 * Seed the resolver registry from config: register the built-ins, then any
 * host-provided inline instances (`config.resolvers` plus instances embedded in
 * `resolverChain`), then set the chain, mapping each instance to its name.
 * Falls back to the single `resolverStrategy` when no chain is configured.
 */
export function wireResolverChain(
  registry: TenantResolverRegistry,
  config: MultitenancyConfig
): void {
  for (const r of builtInResolvers) {
    if (!registry.has(r.name)) registry.register(r)
  }
  const inline: TenantResolver[] = [
    ...(config.resolvers ?? []),
    ...(config.resolverChain ?? []).filter(isResolverInstance),
  ]
  for (const r of inline) {
    if (!registry.has(r.name)) registry.register(r)
  }
  registry.setChain(canonicalChainNames(config))
}

/**
 * Build a fully-seeded {@link TenantResolverRegistry} from config, with no
 * container or Ignitor: the built-ins plus any host-provided inline instances are
 * registered and the canonical chain is set. This is the pure resolution
 * authority — the same wiring the provider applies to the container singleton at
 * boot — usable from a unit test that never boots the app, and the fallback the
 * request path builds on demand before the provider has seeded the singleton (so
 * a solitary `resolverStrategy` still resolves through the chain, never a
 * divergent legacy switch).
 */
export function buildResolverRegistry(config: MultitenancyConfig): TenantResolverRegistry {
  const registry = new TenantResolverRegistry()
  wireResolverChain(registry, config)
  return registry
}
