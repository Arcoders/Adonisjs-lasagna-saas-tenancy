import type { MultitenancyConfig } from './types/config.js'
import { isProductionNodeEnv } from './utils/env.js'
import { getStore } from './config_store.js'

/**
 * Recursively freeze the config so a consumer cannot mutate the shared singleton
 * out from under concurrent requests (`getConfig().isolation.driver = ...`). Plain
 * objects and arrays are frozen deep; functions (e.g. `authorizeTenantAccess`) are
 * frozen shallowly so they stay callable; primitives pass through. Already-frozen
 * branches are skipped so a config that reuses a shared sub-object is cheap and
 * cycle-safe.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (Object.isFrozen(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    return Object.freeze(value)
  }
  if (typeof value === 'function') return Object.freeze(value)
  return value
}

/**
 * Identity helper that anchors the user's `config/multitenancy.ts` to the
 * MultitenancyConfig type. Same pattern as `@adonisjs/lucid` and `@adonisjs/auth`:
 * runtime is a passthrough, the value is type-checked at the call site so
 * IDE autocomplete and `tsc` catch shape errors before boot.
 */
export function defineConfig(config: MultitenancyConfig): MultitenancyConfig {
  return config
}

export function setConfig(config: MultitenancyConfig): void {
  const store = getStore()
  // In production a second set is refused: swapping the isolation config out from
  // under in-flight requests is never intentional (a double boot, a stray call),
  // and silently honouring it could re-point tenants at the wrong schema. Outside
  // production the call is permitted so test suites can re-seed per case.
  if (store.current !== null && isProductionNodeEnv()) {
    throw new Error(
      '@adonisjs-lasagna/saas-tenancy: setConfig was called a second time in production. ' +
        'The multitenancy configuration is set once at boot and is immutable thereafter.'
    )
  }
  store.current = deepFreeze(config)
}

// `__resetConfigForTests` used to live here. It now sits on the `/testing`
// barrel (src/testing/config_reset.ts): this module is public at `/config`, so
// a test-only reset exported from it was a test seam on the app-facing surface.

export function getConfig(): MultitenancyConfig {
  const store = getStore()
  if (!store.current) {
    throw new Error(
      '@adonisjs-lasagna/saas-tenancy not configured. Add MultitenancyProvider to your providers list.'
    )
  }
  return store.current
}
