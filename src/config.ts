import type { MultitenancyConfig } from './types/config.js'

let _config: MultitenancyConfig | null = null

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
  _config = config
}

export function getConfig(): MultitenancyConfig {
  if (!_config) {
    throw new Error(
      '@adonisjs-lasagna/saas-tenancy not configured. Add MultitenancyProvider to your providers list.'
    )
  }
  return _config
}
