import app from '@adonisjs/core/services/app'
import IsolationDriverRegistry from './registry.js'
import type { IsolationDriver } from './driver.js'

/**
 * Cached lookup of the active `IsolationDriver`. Container resolution
 * isn't free, so we memoize after the first call. Tests can clear the
 * cache via {@link __resetActiveDriverCache}.
 */
let cached: IsolationDriverRegistry | undefined

export async function getActiveDriver(): Promise<IsolationDriver> {
  if (!cached) cached = await app.container.make(IsolationDriverRegistry)
  return cached.active()
}

/**
 * Test-only: forget the cached registry so the next `getActiveDriver()`
 * call resolves freshly from the container (or from a manually-injected
 * registry via `__setActiveDriverRegistryForTests`).
 */
export function __resetActiveDriverCache(): void {
  cached = undefined
}

/**
 * Test-only: inject an `IsolationDriverRegistry` directly, skipping the
 * container. Used by unit tests so they don't have to boot the full
 * AdonisJS app.
 */
export function __setActiveDriverRegistryForTests(registry: IsolationDriverRegistry): void {
  cached = registry
}
