import { createGuardAudit } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type {
  GuardCountersSnapshot,
  GuardEmitOptions,
  GuardMetricSink,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import { aiGuardEntry, type AiGuardId } from './ai_guard_registry.js'

/**
 * The AI satellite's Isthmus guard-audit: one instance of the shared
 * {@link createGuardAudit} factory (`@adonisjs-lasagna/saas-tenancy/sdk`), bound
 * to the AI package's `AI_GUARD_REGISTRY`. The limiter mechanics, the counter
 * discipline, the fire-and-forget dispatch contract, and the 10s window all live
 * in the kernel factory now — this file is just the satellite-local binding plus
 * the exported names the AI provider and guard sites call.
 *
 * The factory gives each instance its OWN windows and counters, which is exactly
 * the divergence the satellite needs: an AI-surface burst cannot consume the
 * kernel's per-severity dispatch budget (masking kernel seal/critical events),
 * and AI trips never skew the kernel's dropped counters. The budget VALUES are
 * the shared `ISTHMUS_BUDGETS` inside the factory, so both layers stay tuned
 * together on a kernel retune.
 *
 * AI guard trips do NOT appear in the kernel's `multitenancy_isthmus_*`
 * Prometheus counters (those render kernel-internal state only). They surface
 * through the shared `IsthmusGuardTripped` event and, per tenant, through the
 * `ai_guard_rejections` integer metric via {@link setAiGuardMetricSink}.
 */

/** The per-tenant integer-metric bridge (`ai_guard_rejections`), wired by the provider. */
export const AI_GUARD_REJECTIONS_METRIC = 'ai_guard_rejections'

const audit = createGuardAudit<AiGuardId>({
  lookup: aiGuardEntry,
  metricName: AI_GUARD_REJECTIONS_METRIC,
})

/**
 * Whether an event of this severity may dispatch now, under that severity's
 * fixed-window budget. Pure-ish (takes `now`) so the limiter is unit-testable.
 */
export const allowAiGuardEvent = audit.allow

/** Immutable counter snapshot for specs and diagnostics (one seam, one reader). */
export const snapshotAiGuardCounters = audit.snapshot

/** Test seam: reset the limiter so a spec starts from a clean window. */
export const __resetAiGuardRateLimit = audit.resetRateLimit

/** Test seam: reset the counters so a spec asserts absolute values. */
export const __resetAiGuardCounters = audit.resetCounters

/** Test seam: replace the dispatcher without booting an app. Pass undefined to restore. */
export const __setAiGuardDispatcherForTests = audit.setDispatcher

/**
 * Install the per-tenant metric bridge. `AiProvider.register()` points this at
 * `MetricsService.emitMetric`; pass undefined to detach (tests). Fires only for
 * trips that carry a tenant id (mount and boot guards are tenant-less), and is
 * fire-and-forget: a slow or failing metric write can never touch the reject
 * path.
 */
export const setAiGuardMetricSink = audit.setMetricSink

/**
 * Record an AI guard trip: bump the counters, bridge the per-tenant metric,
 * then dispatch the public `IsthmusGuardTripped` event (best-effort,
 * rate-limited, fire-and-forget). Synchronous and it NEVER throws. Call it on
 * the line BEFORE the guard's throw, never after. Must not read config:
 * config-phase guards trip before the app exists.
 */
export function emitAiGuardEvent(id: AiGuardId, options: AiGuardEmitOptions = {}): void {
  audit.emit(id, options)
}

export type AiGuardMetricSink = GuardMetricSink
export type AiGuardEmitOptions = GuardEmitOptions
export type AiGuardCountersSnapshot = GuardCountersSnapshot<AiGuardId>
