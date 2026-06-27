import type { MultitenancyConfig } from './types/config.js'
import { isProductionNodeEnv } from './utils/env.js'

/**
 * Stash the config singleton on a `Symbol.for(...)` key on `globalThis` so
 * src/ and build/ instances of this module share state. Without this, the
 * package self-references its own build/ output via the `exports` map
 * (`@adonisjs-lasagna/saas-tenancy/...` → `./build/src/...`), while
 * integration specs and the package's own internal imports from `'./...'`
 * resolve to a SECOND copy of this module under src/. Each copy would have
 * its own `let _config = null`, so the provider booting from build/ would
 * leave src/'s `_config` permanently null — and any code reading from src/
 * (`request.tenant()` macro, billing middleware/job/listener, etc.) would
 * throw "saas-tenancy not configured" on the first call.
 *
 * `Symbol.for` is registry-keyed, so the same key resolves to the same
 * symbol across realms / module instances. The store is shared.
 */
const STORE_KEY = Symbol.for('@adonisjs-lasagna/saas-tenancy/config-singleton')

interface ConfigStore {
  current: MultitenancyConfig | null
  /** Monotonic version, bumped on every successful set (the envelope). */
  version: number
}

function getStore(): ConfigStore {
  const g = globalThis as unknown as Record<symbol, ConfigStore | undefined>
  let store = g[STORE_KEY]
  if (!store) {
    store = { current: null, version: 0 }
    g[STORE_KEY] = store
  }
  return store
}

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
  store.version += 1
}

/** Current config version (0 before the first set). The {version, config} envelope. */
export function getConfigVersion(): number {
  return getStore().version
}

/**
 * Test-only: clear the config singleton so `getConfig()` throws again, used to
 * exercise the "config unreadable" fail-closed paths. Mirrors
 * `__configureTenancyForTests`; never call it from runtime code.
 */
export function __resetConfigForTests(): void {
  getStore().current = null
}

export function getConfig(): MultitenancyConfig {
  const store = getStore()
  if (!store.current) {
    throw new Error(
      '@adonisjs-lasagna/saas-tenancy not configured. Add MultitenancyProvider to your providers list.'
    )
  }
  return store.current
}
