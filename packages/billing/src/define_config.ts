import type { MultitenancyConfig, BillingConfig } from '@adonisjs-lasagna/saas-tenancy/types'

export type { BillingConfig }

/**
 * The host's `config/multitenancy.ts` shape with the billing block present.
 * Mirrors the reporting satellite's `MultitenancyConfigWithReporting` so every
 * config-bearing satellite exposes the same authoring surface.
 */
export type MultitenancyConfigWithBilling = MultitenancyConfig & { billing?: BillingConfig }

/**
 * Identity helper for IDE autocomplete + type-checking when authoring the
 * `billing` block of `config/multitenancy.ts`. No runtime effect.
 */
export function defineBillingConfig(config: BillingConfig): BillingConfig {
  return config
}
