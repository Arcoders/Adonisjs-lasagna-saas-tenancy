import app from '@adonisjs/core/services/app'
import BillingDriverRegistry from './billing_driver_registry.js'
import type { BillingProviderContract } from '../../contracts/billing_provider_contract.js'

/**
 * Cached lookup of the active billing driver. Container resolution isn't free,
 * so we memoize after the first call. Mirrors `getActiveDriver()` for isolation.
 */
let cached: BillingDriverRegistry | undefined

export async function getActiveBillingDriver(): Promise<BillingProviderContract> {
  if (!cached) cached = await app.container.make(BillingDriverRegistry)
  return cached.active()
}

/**
 * Test-only: forget the cached registry so the next `getActiveBillingDriver()`
 * resolves freshly from the container (or from a manually-injected registry).
 */
export function __resetActiveBillingDriverCache(): void {
  cached = undefined
}

/**
 * Test-only: inject a `BillingDriverRegistry` directly, skipping the container.
 * Used by unit tests so they don't have to boot the full AdonisJS app.
 */
export function __setActiveBillingDriverRegistryForTests(registry: BillingDriverRegistry): void {
  cached = registry
}
