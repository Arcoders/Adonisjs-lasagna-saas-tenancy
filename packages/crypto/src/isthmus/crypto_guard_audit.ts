import { createGuardAudit } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type {
  GuardCountersSnapshot,
  GuardEmitOptions,
  GuardMetricSink,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import { cryptoGuardEntry, type CryptoGuardId } from './crypto_guard_registry.js'

/**
 * The crypto satellite's Isthmus guard-audit: one instance of the shared
 * {@link createGuardAudit} factory (`@adonisjs-lasagna/saas-tenancy/sdk`), bound
 * to the crypto package's `CRYPTO_GUARD_REGISTRY`. The limiter mechanics, the
 * counter discipline, the fire-and-forget dispatch contract, and the 10s window
 * all live in the kernel factory now. This file is just the satellite-local
 * binding plus the exported names the crypto provider and guard sites call.
 *
 * The factory gives each instance its own windows and counters (the same
 * divergence as AI): a crypto-surface burst cannot consume the kernel's
 * per-severity dispatch budget. The budget values are the shared `ISTHMUS_BUDGETS`
 * inside the factory, so both layers stay tuned together on a kernel retune.
 *
 * Crypto guard trips do NOT appear in the kernel's `multitenancy_isthmus_*`
 * Prometheus counters. They surface through the shared `IsthmusGuardTripped`
 * event and, per tenant, through the `crypto_guard_rejections` integer metric
 * via {@link setCryptoGuardMetricSink}. Raw key material is NEVER placed in the
 * metadata: call sites pass only non-secret ids or sizes.
 */

/** The per-tenant integer-metric bridge (`crypto_guard_rejections`), wired by the provider. */
export const CRYPTO_GUARD_REJECTIONS_METRIC = 'crypto_guard_rejections'

const audit = createGuardAudit<CryptoGuardId>({
  lookup: cryptoGuardEntry,
  metricName: CRYPTO_GUARD_REJECTIONS_METRIC,
})

/**
 * Whether an event of this severity may dispatch now, under that severity's
 * fixed-window budget. Pure-ish (takes `now`) so the limiter is unit-testable.
 */
export const allowCryptoGuardEvent = audit.allow

/** Immutable counter snapshot for specs and diagnostics (one seam, one reader). */
export const snapshotCryptoGuardCounters = audit.snapshot

/** Test seam: reset the limiter so a spec starts from a clean window. */
export const __resetCryptoGuardRateLimit = audit.resetRateLimit

/** Test seam: reset the counters so a spec asserts absolute values. */
export const __resetCryptoGuardCounters = audit.resetCounters

/** Test seam: replace the dispatcher without booting an app. Pass undefined to restore. */
export const __setCryptoGuardDispatcherForTests = audit.setDispatcher

/**
 * Install the per-tenant metric bridge. The provider points this at
 * `MetricsService.emitMetric`; pass undefined to detach (tests). Fires only for
 * trips that carry a tenant id (config and boot guards are tenant-less), and is
 * fire-and-forget: a slow or failing metric write can never touch the reject
 * path.
 */
export const setCryptoGuardMetricSink = audit.setMetricSink

/**
 * Record a crypto guard trip: bump the counters, bridge the per-tenant metric,
 * then dispatch the public `IsthmusGuardTripped` event (best-effort,
 * rate-limited, fire-and-forget). Synchronous and it NEVER throws. Call it on
 * the line BEFORE the guard's throw, never after. Must not read config:
 * config-phase guards trip before the app exists. Never put raw key material in
 * `metadata`.
 */
export function emitCryptoGuardEvent(
  id: CryptoGuardId,
  options: CryptoGuardEmitOptions = {}
): void {
  audit.emit(id, options)
}

export type CryptoGuardMetricSink = GuardMetricSink
export type CryptoGuardEmitOptions = GuardEmitOptions
export type CryptoGuardCountersSnapshot = GuardCountersSnapshot<CryptoGuardId>
