import type {
  IsthmusDropReason,
  IsthmusGuardTrippedPayload,
  IsthmusSeverity,
} from '@adonisjs-lasagna/saas-tenancy/types'
import { ISTHMUS_BUDGETS } from '@adonisjs-lasagna/saas-tenancy/internal'
import { cryptoGuardEntry, type CryptoGuardId } from './crypto_guard_registry.js'

/**
 * Best-effort, severity-aware instrumentation for the crypto satellite's guards,
 * mirroring the AI satellite's `emitAiGuardEvent` and the kernel's `emitIsthmusEvent`
 * contract line for line:
 *
 *   1. Counters first, always: `emitCryptoGuardEvent` synchronously bumps the
 *      in-process counters before anything else, so they work in every phase
 *      (config-time boot guards, bare unit runners, runtime).
 *   2. Everything dropped is counted: the rate limiter and the dispatcher can only
 *      suppress the EVENT; each suppression increments the dropped counter, so
 *      nothing is ever silently lost.
 *   3. The reject path is untouchable: dispatch is fire-and-forget (never awaited)
 *      and swallowed (never throws), and the emit happens BEFORE the guard's throw.
 *
 * Divergence from the kernel, on purpose (same as AI): the rate-limit WINDOWS are
 * satellite-local so a crypto-surface burst cannot consume the kernel's per-severity
 * dispatch budget. The budget VALUES are imported from the kernel so both layers stay
 * tuned together; `/internal` is unstable by contract, so if the kernel retunes
 * `ISTHMUS_BUDGETS`, the satellite follows silently (intended).
 *
 * Crypto guard trips do NOT appear in the kernel's `multitenancy_isthmus_*` Prometheus
 * counters. They surface through the shared `IsthmusGuardTripped` event and, per
 * tenant, through the `crypto_guard_rejections` integer metric via
 * {@link setCryptoGuardMetricSink}. Raw key material is NEVER placed in the metadata
 * (I9): call sites pass only non-secret ids / sizes.
 */

/** Window length, matching the kernel limiter. */
const WINDOW_MS = 10_000

interface SeverityWindow {
  windowStart: number
  count: number
}

const windows = new Map<IsthmusSeverity, SeverityWindow>()

/**
 * Whether an event of this severity may dispatch now, under that severity's fixed-window
 * budget. Pure-ish (takes `now`) so the limiter is unit-testable without faking time.
 */
export function allowCryptoGuardEvent(severity: IsthmusSeverity, now: number): boolean {
  let window = windows.get(severity)
  if (!window || now - window.windowStart >= WINDOW_MS) {
    window = { windowStart: now, count: 0 }
    windows.set(severity, window)
  }
  if (window.count >= ISTHMUS_BUDGETS[severity]) return false
  window.count++
  return true
}

/** Test seam: reset the limiter so a spec starts from a clean window. */
export function __resetCryptoGuardRateLimit(): void {
  windows.clear()
}

// Monotonic in-process counters, bumped BEFORE the rate limiter so totals stay exact
// even when event dispatch drops. Composite string keys keep the maps flat.
const guardedCounts = new Map<string, number>()
const rejectedCounts = new Map<CryptoGuardId, number>()
const droppedCounts = new Map<string, number>()

function bump<K extends string>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function bumpDropped(severity: IsthmusSeverity, reason: IsthmusDropReason): void {
  bump(droppedCounts, `${severity} ${reason}`)
}

/** Immutable counter snapshot for specs and diagnostics (one seam, one reader). */
export interface CryptoGuardCountersSnapshot {
  readonly guarded: ReadonlyArray<{ severity: IsthmusSeverity; value: number }>
  readonly rejected: ReadonlyArray<{ id: CryptoGuardId; severity: IsthmusSeverity; value: number }>
  readonly dropped: ReadonlyArray<{
    severity: IsthmusSeverity
    reason: IsthmusDropReason
    value: number
  }>
}

export function snapshotCryptoGuardCounters(): CryptoGuardCountersSnapshot {
  return {
    guarded: [...guardedCounts].map(([severity, value]) => {
      return { severity: severity as IsthmusSeverity, value }
    }),
    rejected: [...rejectedCounts].map(([id, value]) => {
      return { id, severity: cryptoGuardEntry(id).severity, value }
    }),
    dropped: [...droppedCounts].map(([key, value]) => {
      const [severity, reason] = key.split(' ')
      return { severity: severity as IsthmusSeverity, reason: reason as IsthmusDropReason, value }
    }),
  }
}

/** Test seam: reset the counters so a spec asserts absolute values. */
export function __resetCryptoGuardCounters(): void {
  guardedCounts.clear()
  rejectedCounts.clear()
  droppedCounts.clear()
}

/** The per-tenant integer-metric bridge (`crypto_guard_rejections`), wired by the provider. */
export const CRYPTO_GUARD_REJECTIONS_METRIC = 'crypto_guard_rejections'

export type CryptoGuardMetricSink = (
  tenantId: string,
  name: string,
  value: number
) => void | Promise<void>

let metricSink: CryptoGuardMetricSink | undefined

/**
 * Install the per-tenant metric bridge. The provider points this at
 * `MetricsService.emitMetric`; pass undefined to detach (tests). Fires only for trips
 * that carry a tenant id (config and boot guards are tenant-less), and is
 * fire-and-forget: a slow or failing metric write can never touch the reject path.
 */
export function setCryptoGuardMetricSink(sink: CryptoGuardMetricSink | undefined): void {
  metricSink = sink
}

export interface CryptoGuardEmitOptions {
  readonly tenantId?: string | null
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
}

type CryptoGuardDispatcher = (payload: IsthmusGuardTrippedPayload) => Promise<void>

/**
 * The default dispatcher resolves the kernel's public event class lazily, so importing
 * this module never drags app machinery and it stays safe for bare unit runners.
 * `BaseEvent.dispatch()` throws when the static emitter is unwired (no booted app); the
 * caller's catch absorbs that into dropped{no_emitter}.
 */
const defaultDispatcher: CryptoGuardDispatcher = async (payload) => {
  const { IsthmusGuardTripped } = await import('@adonisjs-lasagna/saas-tenancy/events')
  await IsthmusGuardTripped.dispatch(payload)
}

let dispatcher: CryptoGuardDispatcher = defaultDispatcher

/** Test seam: replace the dispatcher without booting an app. Pass undefined to restore. */
export function __setCryptoGuardDispatcherForTests(fn: CryptoGuardDispatcher | undefined): void {
  dispatcher = fn ?? defaultDispatcher
}

/**
 * Record a crypto guard trip: bump the counters, bridge the per-tenant metric, then
 * dispatch the public `IsthmusGuardTripped` event (best-effort, rate-limited,
 * fire-and-forget). Synchronous and it NEVER throws. Call it on the line BEFORE the
 * guard's throw, never after. Must not read config: config-phase guards trip before
 * the app exists. Never put raw key material in `metadata` (I9).
 */
export function emitCryptoGuardEvent(
  id: CryptoGuardId,
  options: CryptoGuardEmitOptions = {}
): void {
  try {
    const entry = cryptoGuardEntry(id)
    bump(guardedCounts, entry.severity)
    bump(rejectedCounts, id)

    // The metric bridge is a counter-like signal, so it sits with the counters, ahead
    // of the rate limiter, and shares the dispatcher's sync-throw-safe wrap.
    const sink = metricSink
    if (sink && options.tenantId) {
      const tenantId = options.tenantId
      void Promise.resolve()
        .then(() => sink(tenantId, CRYPTO_GUARD_REJECTIONS_METRIC, 1))
        .catch(() => {})
    }

    if (!allowCryptoGuardEvent(entry.severity, Date.now())) {
      bumpDropped(entry.severity, 'rate_limited')
      return
    }

    const payload: IsthmusGuardTrippedPayload = {
      id: entry.id,
      pillar: entry.pillar,
      bugClass: entry.bugClass,
      severity: entry.severity,
      event: entry.event,
      tenantId: options.tenantId ?? null,
      metadata: options.metadata ?? {},
    }
    // Fire-and-forget with the kernel's exact discipline: capture the dispatcher
    // eagerly (a later test swap can never redirect an in-flight dispatch) and route
    // even a SYNCHRONOUSLY-throwing dispatcher through Promise.resolve().then so the
    // drop is always counted.
    const dispatch = dispatcher
    void Promise.resolve()
      .then(() => dispatch(payload))
      .catch(() => bumpDropped(entry.severity, 'no_emitter'))
  } catch {
    // Auditing a rejection must never break the reject path.
  }
}
