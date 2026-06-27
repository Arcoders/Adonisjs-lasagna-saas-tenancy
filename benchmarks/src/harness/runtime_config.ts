import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'

type IsolationConfig = NonNullable<MultitenancyConfig['isolation']>

/**
 * Re-publish the tenancy config with a patched `isolation` block.
 *
 * The config singleton is deep-frozen by `setConfig`, so a bench that varies the
 * connection cap, eviction grace, or hard-cap flag at runtime cannot mutate
 * `getConfig().isolation` in place — that throws `TypeError: Cannot assign to read
 * only property`. Re-setting a fresh object is permitted outside production, which
 * is where the benches run (`NODE_ENV=development`). Use this from any bench that
 * needs to retune isolation live, rather than reaching into the frozen config.
 */
export function patchIsolationConfig(patch: Partial<IsolationConfig>): void {
  const cfg = getConfig()
  setConfig({ ...cfg, isolation: { ...cfg.isolation, ...patch } as IsolationConfig })
}
