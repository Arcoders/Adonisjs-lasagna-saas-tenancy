import type { MultitenancyConfig } from './types/config.js'

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
}

function getStore(): ConfigStore {
  const g = globalThis as unknown as Record<symbol, ConfigStore | undefined>
  let store = g[STORE_KEY]
  if (!store) {
    store = { current: null }
    g[STORE_KEY] = store
  }
  return store
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
  getStore().current = config
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
