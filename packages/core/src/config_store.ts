import type { MultitenancyConfig } from './types/config.js'

/**
 * Stash the config singleton on a `Symbol.for(...)` key on `globalThis` so
 * src/ and build/ instances of this module share state. Without this, the
 * package self-references its own build/ output via the `exports` map
 * (`@adonisjs-lasagna/saas-tenancy/...` resolves to `./build/src/...`), while
 * integration specs and the package's own internal imports from `'./...'`
 * resolve to a SECOND copy of this module under src/. Each copy would have
 * its own `let _config = null`, so the provider booting from build/ would
 * leave src/'s `_config` permanently null, and any code reading from src/
 * (`request.tenant()` macro, billing middleware/job/listener, etc.) would
 * throw "saas-tenancy not configured" on the first call.
 *
 * `Symbol.for` is registry-keyed, so the same key resolves to the same
 * symbol across realms / module instances. The store is shared.
 *
 * This module carries no subpath in `package.json` `exports`, which is the
 * point: `config.ts` is public at `/config` (billing and five other satellites
 * import it), so a test-only reset exported from there would be public too.
 * Keeping the store accessor here lets `src/testing/config_reset.ts` reach the
 * singleton over a compile-time link instead of re-deriving the `Symbol.for`
 * literal, which would silently no-op the day this key changes.
 *
 * Invariant: one tenancy configuration per process. The store is process-global
 * and keyed by a single fixed `Symbol.for`, so a process hosts exactly one
 * MultitenancyProvider. A second `setConfig` in production is refused (see
 * `config.ts`), and running two apps with different tenancy configs in one
 * process is unsupported. Tests that re-seed or clear the singleton go through
 * the `/testing` reset seam (`__resetConfigForTests`), never by re-deriving this
 * key.
 */
const STORE_KEY = Symbol.for('@adonisjs-lasagna/saas-tenancy/config-singleton')

export interface ConfigStore {
  current: MultitenancyConfig | null
}

export function getStore(): ConfigStore {
  const g = globalThis as unknown as Record<symbol, ConfigStore | undefined>
  let store = g[STORE_KEY]
  if (!store) {
    store = { current: null }
    g[STORE_KEY] = store
  }
  return store
}
