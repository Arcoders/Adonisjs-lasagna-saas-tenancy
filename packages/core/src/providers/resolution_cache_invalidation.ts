import type { Emitter } from '@adonisjs/core/events'
import {
  TenantActivated,
  TenantSuspended,
  TenantDeleted,
  TenantUpdated,
  TenantProvisioned,
  TenantRestored,
  TenantEnteredMaintenance,
  TenantExitedMaintenance,
} from '../events/index.js'

/** The subset of {@link TenantResolutionCache} this wiring depends on. */
export interface ResolutionCacheLike {
  delete(id: string): void
}

/**
 * Tenant-lifecycle events whose subject tenant must be evicted from the
 * in-process resolution cache the instant they fire, so a suspend / maintenance
 * / delete / status change takes effect on this pod immediately instead of
 * waiting out the TTL. (Cross-pod propagation is still bounded by the TTL.)
 */
export const RESOLUTION_CACHE_INVALIDATING_EVENTS = [
  TenantActivated,
  TenantSuspended,
  TenantDeleted,
  TenantUpdated,
  TenantProvisioned,
  TenantRestored,
  TenantEnteredMaintenance,
  TenantExitedMaintenance,
]

/**
 * Subscribe in-process resolution-cache invalidation to every tenant-lifecycle
 * event on `emitter`, and return a teardown that removes every listener again.
 *
 * Must run with a fully-constructed emitter, i.e. only after the app is booted,
 * which is why `MultitenancyProvider` calls this from `ready()` and resolves the
 * emitter via `container.make('emitter')`, NEVER from `boot()` via the
 * `@adonisjs/core/services/emitter` module. That module only assigns its default
 * export inside an `app.booted()` hook; imported during `boot()` (before the
 * booted hooks run) it resolves to `undefined`, which silently drops every
 * subscription and leaves the cache stale until the TTL, the exact regression
 * this seam exists to make testable.
 */
export function wireResolutionCacheInvalidation(
  emitter: Emitter<any>,
  cache: ResolutionCacheLike
): () => void {
  const unsubscribes: Array<() => void> = []
  for (const Event of RESOLUTION_CACHE_INVALIDATING_EVENTS) {
    unsubscribes.push(
      emitter.on(Event, (event: { tenant?: { id?: string } }) => {
        const id = event?.tenant?.id
        if (id) cache.delete(id)
      })
    )
  }
  return () => {
    for (const off of unsubscribes) off()
  }
}
