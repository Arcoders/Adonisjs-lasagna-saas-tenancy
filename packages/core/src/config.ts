import type { MultitenancyConfig, ResolvedMultitenancyConfig } from './types/config.js'
import type { WarmPoolConfig } from './types/config/isolation.js'
import { isProductionNodeEnv } from './utils/env.js'
import { getStore } from './config_store.js'
import { resolveConfig } from './config_defaults.js'

/**
 * Recursively freeze the config so a consumer cannot mutate the shared singleton
 * out from under concurrent requests (`getConfig().isolation.driver = ...`). Plain
 * objects and arrays are frozen deep; functions (e.g. `authorizeTenantAccess`) are
 * frozen shallowly so they stay callable; primitives pass through. Class instances
 * (a stateful custom resolver in `resolverChain`/`resolvers`, documented to hit a
 * cache or remote service) are left untouched so they keep owning their own state.
 * Already-frozen branches are skipped so a config that reuses a shared sub-object
 * is cheap and cycle-safe.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (Object.isFrozen(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  // Recurse into PLAIN objects only. A class instance (`constructor !== Object`)
  // is left alone: freezing a stateful custom resolver would violate its
  // ownership and can break a resolver that mutates its own fields to cache or
  // batch. Only the framework's plain config tree is sealed against mutation.
  if (typeof value === 'object' && (value as object).constructor === Object) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    return Object.freeze(value)
  }
  if (typeof value === 'function') return Object.freeze(value)
  return value
}

/**
 * Anchors the user's `config/multitenancy.ts` to the MultitenancyConfig INPUT
 * type and resolves it against the single `CONFIG_DEFAULTS`. Same input→resolved
 * pattern as `@adonisjs/lucid` and `@adonisjs/auth`: the value is type-checked at
 * the call site (IDE autocomplete + `tsc` catch shape errors before boot) and the
 * returned {@link ResolvedMultitenancyConfig} has the always-present tunables
 * filled in. `setConfig` re-resolves idempotently, so an app that writes an
 * untyped config object without calling this still gets a resolved `getConfig()`.
 */
export function defineConfig(config: MultitenancyConfig): ResolvedMultitenancyConfig {
  return resolveConfig(config)
}

/**
 * Typed sugar for the F2 warm-pool block (`isolation.warmPool`). Anchors the value
 * to {@link WarmPoolConfig} at the call site (IDE autocomplete + `tsc` catch shape
 * errors) exactly like `defineConfig`. Adds nothing at runtime, so a host can
 * equally write the object literal; it exists for discoverability and parity with
 * the other `define*` helpers. The tenant set stays operator-declared: pass a
 * static `tenants` list or an authenticated `selectTenants` hook, never a value
 * derived from a request.
 */
export function defineWarmPool(config: WarmPoolConfig): WarmPoolConfig {
  return config
}

export function setConfig(config: MultitenancyConfig, options?: { inProduction?: boolean }): void {
  const store = getStore()
  // In production a second set is refused: swapping the isolation config out from
  // under in-flight requests is never intentional (a double boot, a stray call),
  // and silently honouring it could re-point tenants at the wrong schema. Outside
  // production the call is permitted so test suites can re-seed per case.
  //
  // "In production" is the app's own verdict when the provider calls this
  // (`app.inProduction`, the single authority); the NODE_ENV read is the fallback
  // for direct callers (tests, tooling) that have no booted app in hand.
  const inProduction = options?.inProduction ?? isProductionNodeEnv()
  if (store.current !== null && inProduction) {
    throw new Error(
      '@adonisjs-lasagna/saas-tenancy: setConfig was called a second time in production. ' +
        'The multitenancy configuration is set once at boot and is immutable thereafter.'
    )
  }
  // Resolve here (not only in `defineConfig`) so the store is the single choke
  // point: an app that wrote an untyped config object, or a test that seeds a
  // partial one, still yields a fully-resolved `getConfig()`. `resolveConfig` is
  // idempotent, so re-resolving a config that already went through `defineConfig`
  // is a no-op.
  store.current = deepFreeze(resolveConfig(config))
}

// `__resetConfigForTests` used to live here. It now sits on the `/testing`
// barrel (src/testing/config_reset.ts): this module is public at `/config`, so
// a test-only reset exported from it was a test seam on the app-facing surface.

export function getConfig(): ResolvedMultitenancyConfig {
  const store = getStore()
  if (!store.current) {
    throw new Error(
      '@adonisjs-lasagna/saas-tenancy not configured. Add MultitenancyProvider to your providers list.'
    )
  }
  return store.current
}
