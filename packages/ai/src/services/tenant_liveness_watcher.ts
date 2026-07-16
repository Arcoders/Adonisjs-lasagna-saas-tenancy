import type { Emitter } from '@adonisjs/core/events'
import { TenantSuspended, TenantDeleted } from '@adonisjs-lasagna/saas-tenancy/events'

/**
 * The tenant-lifecycle events that revoke in-flight AI streams (G11, the
 * TOCTOU suspend-mid-stream gap): a stream re-checks nothing itself; it holds
 * a liveness signal that this watcher aborts the instant the tenant stops
 * being servable. Maintenance events are deliberately excluded: maintenance is
 * a pause, not a revocation, and an in-flight response finishing during a
 * maintenance window leaks nothing.
 *
 * Honest limit (documented in the guide): the event fires on the pod where the
 * lifecycle change ran, so cross-pod mid-stream aborts are not guaranteed.
 * Cross-pod enforcement remains TenantGuard on the next request, the same
 * posture as the kernel's resolution-cache TTL caveat.
 */
export const AI_LIVENESS_REVOKING_EVENTS = [TenantSuspended, TenantDeleted]

/**
 * Per-process registry of live stream abort handles, keyed by tenant id.
 * Stateful and cross-request, so it is a container singleton resolved via
 * `container.make` (the platform rule), registered by `AiProvider.register()`
 * and wired to the emitter in `ready()`.
 */
export default class TenantLivenessWatcher {
  readonly #controllers = new Map<string, Set<AbortController>>()

  /**
   * Obtain a liveness signal for one stream. The caller passes `signal` to the
   * streaming spine as `livenessSignal` and MUST call `dispose()` in a finally
   * block; dispose is idempotent and only detaches this stream's handle (a
   * disposed stream can no longer be aborted, and the per-tenant set is pruned
   * so the map never leaks finished streams).
   */
  acquire(tenantId: string): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController()
    let handles = this.#controllers.get(tenantId)
    if (!handles) {
      handles = new Set()
      this.#controllers.set(tenantId, handles)
    }
    handles.add(controller)

    let disposed = false
    return {
      signal: controller.signal,
      dispose: () => {
        if (disposed) return
        disposed = true
        const current = this.#controllers.get(tenantId)
        if (current) {
          current.delete(controller)
          if (current.size === 0) this.#controllers.delete(tenantId)
        }
      },
    }
  }

  /** Abort every live stream of one tenant. Returns how many were aborted. */
  revoke(tenantId: string): number {
    const handles = this.#controllers.get(tenantId)
    if (!handles) return 0
    this.#controllers.delete(tenantId)
    for (const controller of handles) {
      controller.abort()
    }
    return handles.size
  }

  /** How many tenants currently hold at least one live stream (leak probe for specs). */
  watchedTenantCount(): number {
    return this.#controllers.size
  }
}

/**
 * Subscribe the watcher to every revoking lifecycle event on `emitter` and
 * return a teardown that removes every listener again. Mirrors the kernel's
 * `wireResolutionCacheInvalidation` discipline, including its documented trap:
 * call this from `ready()` with `container.make('emitter')`, never from
 * `boot()` via the emitter service module (unassigned until the booted hooks
 * run, which would silently drop every subscription).
 */
export function wireAiTenantLiveness(
  emitter: Emitter<any>,
  watcher: TenantLivenessWatcher
): () => void {
  const unsubscribes: Array<() => void> = []
  for (const Event of AI_LIVENESS_REVOKING_EVENTS) {
    unsubscribes.push(
      emitter.on(Event, (event: { tenant?: { id?: string } }) => {
        const id = event?.tenant?.id
        if (id) watcher.revoke(id)
      })
    )
  }
  return () => {
    for (const off of unsubscribes) off()
  }
}
