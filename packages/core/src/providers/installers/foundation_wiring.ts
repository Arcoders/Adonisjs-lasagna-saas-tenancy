import { setConfig } from '../../config.js'
import { assertConfigBounds } from '../assert_config_bounds.js'
import type { MultitenancyConfig } from '../../types/config.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * Asserts the shape that the rest of the package treats as load-bearing.
 * Cheaper than full schema validation, but catches the most common deploy
 * mistakes (missing required field, typoed strategy) at boot rather than
 * leaving them to surface as opaque "undefined" reads at request time.
 * `assertConfigBounds` relies on this having run: it proves the required
 * fields exist and the strategy is known, then bounds catches the next tier.
 */
function assertConfigShape(
  config: MultitenancyConfig | undefined
): asserts config is MultitenancyConfig {
  if (!config) {
    throw new Error(
      'multitenancy config is missing. Add `config/multitenancy.ts` exporting `defineConfig({...})` ' +
        'and register `MultitenancyProvider` in `adonisrc.ts`.'
    )
  }

  const required = [
    'backofficeConnectionName',
    'centralConnectionName',
    'tenantConnectionNamePrefix',
    'tenantSchemaPrefix',
    'resolverStrategy',
  ] as const
  for (const key of required) {
    if (!config[key]) {
      throw new Error(`multitenancy.${key} is required but missing or empty.`)
    }
  }

  const knownStrategies = ['subdomain', 'header', 'path', 'domain-or-subdomain', 'request-data']
  if (!knownStrategies.includes(config.resolverStrategy)) {
    throw new Error(
      `multitenancy.resolverStrategy "${config.resolverStrategy}" is not one of ` +
        `${knownStrategies.join(', ')}.`
    )
  }

  if (config.resolverChain) {
    if (!Array.isArray(config.resolverChain) || config.resolverChain.length === 0) {
      throw new Error('multitenancy.resolverChain must be a non-empty array when set.')
    }
  }
}

/**
 * The config gate. Runs FIRST in boot() so every later installer that reads
 * `getConfig()` succeeds and every unsafe config aborts the deploy before any
 * subsystem wires anything:
 *
 *  1. `assertConfigShape` narrows the config and fails fast on the common deploy
 *     mistakes.
 *  2. `assertConfigBounds` range-checks numeric/secret tunables and runs the
 *     fail-CLOSED resolution-safety gate outside a recognized dev/test env.
 *  3. `setConfig` commits the immutable module singleton — the "setConfig first"
 *     invariant: `getConfig()` throws until this runs.
 *
 * The app is the single authority for which environment we are in: the
 * resolution-safety gate keys on dev/test (fail closed otherwise), and the
 * second-set refusal on production. Both come from `this.app` so neither re-reads
 * NODE_ENV behind the framework's back.
 */
export const foundationWiring: ProviderInstaller = {
  name: 'foundation',

  boot(ctx: InstallerContext): void {
    const config = ctx.app.config.get<MultitenancyConfig>('multitenancy')
    assertConfigShape(config)
    assertConfigBounds(config, { inDevOrTest: ctx.app.inDev || ctx.app.inTest })
    setConfig(config, { inProduction: ctx.app.inProduction })
  },
}
