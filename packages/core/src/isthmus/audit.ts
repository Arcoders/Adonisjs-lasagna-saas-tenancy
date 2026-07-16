import { createGuardAudit, ISTHMUS_BUDGETS } from '../sdk/guard_audit.js'
import type { GuardCountersSnapshot, GuardEmitOptions } from '../sdk/guard_audit.js'
import { isthmusEntry, type IsthmusGuardId } from './registry.js'

/**
 * The kernel's Isthmus guard-audit: one instance of the shared
 * {@link createGuardAudit} factory, bound to the kernel's `ISTHMUS_REGISTRY`.
 * The limiter mechanics, the counter discipline, the fire-and-forget dispatch
 * contract, and the 10s window all live in `sdk/guard_audit.ts` (single source,
 * consumed identically by the AI and crypto satellite audits). The three
 * cross-cutting invariants (counters first, everything dropped is counted, the
 * reject path is untouchable) are pinned there and by this package's specs.
 *
 * The kernel audit takes NO metric bridge: kernel guard trips surface through
 * the shared `IsthmusGuardTripped` event and the `multitenancy_isthmus_*`
 * Prometheus counters (rendered from {@link snapshotIsthmusCounters}), not a
 * per-tenant integer metric.
 */
const audit = createGuardAudit<IsthmusGuardId>({ lookup: isthmusEntry })

/** @see ISTHMUS_BUDGETS. Re-exported from its single source for the kernel's consumers. */
export { ISTHMUS_BUDGETS }

/**
 * Whether an event of this severity may dispatch now, under that severity's
 * fixed-window budget. Pure-ish (takes `now`) so the limiter is unit-testable.
 */
export const allowIsthmusEvent = audit.allow

/**
 * Record a guard trip: bump the counters, then dispatch the public
 * `IsthmusGuardTripped` event (best-effort, rate-limited, fire-and-forget).
 * Synchronous and it NEVER throws. Call it on the line BEFORE the guard's
 * throw, never after. Must not read getConfig(): config-phase guards trip
 * before setConfig() runs.
 */
export function emitIsthmusEvent(id: IsthmusGuardId, options: IsthmusEmitOptions = {}): void {
  audit.emit(id, options)
}

/** Immutable counter snapshot for the Prometheus exporter (one seam, one reader). */
export const snapshotIsthmusCounters = audit.snapshot

/** Test seam: reset the limiter so a spec starts from a clean window. */
export const __resetIsthmusRateLimit = audit.resetRateLimit

/** Test seam: reset the counters so a spec asserts absolute values. */
export const __resetIsthmusCounters = audit.resetCounters

/** Test seam: replace the dispatcher without booting an app. Pass undefined to restore. */
export const __setIsthmusDispatcherForTests = audit.setDispatcher

export type IsthmusCountersSnapshot = GuardCountersSnapshot<IsthmusGuardId>
export type IsthmusEmitOptions = GuardEmitOptions
