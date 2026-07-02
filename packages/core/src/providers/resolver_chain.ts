import type { MultitenancyConfig } from '../types/config.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'
import { builtInResolvers } from '../services/resolvers/index.js'
import type TenantResolverRegistry from '../services/resolvers/registry.js'
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
 * Config-level validation of `resolverChain` (WS-7 / resolver-chain-string-only).
 * Every string entry must name a built-in or an inline instance the host
 * supplied (in `resolverChain` itself or `config.resolvers`). Throws a clear,
 * config-level error naming the offender and the valid options — instead of the
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
 * `resolverChain`), then set the chain — mapping each instance to its name.
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
  const names =
    config.resolverChain && config.resolverChain.length > 0
      ? config.resolverChain.map((entry) => (isResolverInstance(entry) ? entry.name : entry))
      : [config.resolverStrategy]
  registry.setChain(names)
}
