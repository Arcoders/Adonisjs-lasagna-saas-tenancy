import type {
  IsthmusDropReason,
  IsthmusGuardTrippedPayload,
  IsthmusPillar,
  IsthmusSeverity,
} from '../types/isthmus.js'

/**
 * The single, shared implementation of the Isthmus guard-audit: severity-aware,
 * best-effort instrumentation for a fail-closed guard. The kernel and every
 * satellite (AI, crypto, …) build ONE instance of this from their own registry,
 * so the limiter mechanics, the counter discipline, the dispatch contract, and
 * the 10s window live in exactly one place: no line-for-line triplication, no
 * `WINDOW_MS` drift on a kernel retune.
 *
 * The contract every instance upholds (pinned by the kernel's and satellites'
 * unit specs):
 *
 *   1. Counters first, always. `emit` synchronously bumps the in-process
 *      counters before anything else: they have zero dependencies and work in
 *      every phase (config-time boot guards, bare unit runners, runtime).
 *   2. Everything dropped is counted. The rate limiter and the dispatcher can
 *      only suppress the EVENT; each suppression increments the dropped counter,
 *      so nothing is ever silently lost.
 *   3. The reject path is untouchable. Dispatch is fire-and-forget (never
 *      awaited) and swallowed (never throws), and the emit happens BEFORE the
 *      guard's throw, so a slow or failing host listener can neither block nor
 *      mask the rejection.
 *
 * Each instance owns its OWN windows and counters (a fresh closure per
 * `createGuardAudit`), on purpose: sharing the kernel's process-wide windows
 * would let a satellite-surface burst consume the kernel's per-severity dispatch
 * budget (masking kernel seal/critical events) and would skew the kernel's
 * dropped counters with consumption it cannot see. The budget VALUES are the
 * shared `ISTHMUS_BUDGETS` constant, so every layer stays tuned together.
 *
 * Bare-safe: this module statically imports only vocabulary types. The default
 * dispatcher resolves the public `IsthmusGuardTripped` event class LAZILY, so
 * importing it never drags app machinery. A satellite can build its audit from
 * its own unit runner without booting an app.
 */

/** Window length inherited from the proven scope-bypass limiter (10s). Single source. */
const WINDOW_MS = 10_000

/**
 * Per-severity dispatch budgets per window per process. ALL finite by policy: a
 * security control must never let its own telemetry become a load amplifier, so
 * "critical is unlimited" is deliberately rejected. warn/info inherit the proven
 * MAX_PER_WINDOW=50 magnitude of the scope-bypass limiter; critical and high get
 * finite headroom above it because they are the alerting signals a host must not
 * miss during a burst. Deliberately NOT host-configurable: a tunable audit
 * limiter is a disable-your-own-alarms vector. Each severity has an independent
 * window, so a burst at one severity cannot starve another. Shared by the kernel
 * and every satellite audit so a retune moves all layers together.
 */
export const ISTHMUS_BUDGETS = {
  critical: 200,
  high: 100,
  warn: 50,
  info: 20,
} as const satisfies Record<IsthmusSeverity, number>

/**
 * Hard bounds on the metadata a guard-tripped event may broadcast. The event is
 * broadcast process-wide and subscribable by any plugin, so an unbounded metadata
 * bag is both a disclosure surface and a memory-amplification one: a guard fed
 * attacker-influenced input could push a large or high-cardinality bag onto every
 * listener. These are FIXED module constants, not host config, for the same
 * reason the dispatch budgets are: a tunable bound on a security control's own
 * telemetry is a widen-the-disclosure vector. Over-limit metadata is TRUNCATED
 * (extra keys dropped, long string values clipped), never dropped wholesale, and
 * the clip is counted (`dropped{severity,metadata_bounded}`) so nothing is
 * silently lost. Call sites that carry a foreign tenant id in metadata tokenize
 * it (`tokenizeTenantId`) rather than rely on this length clip.
 */
export const MAX_ISTHMUS_METADATA_KEYS = 16
export const MAX_ISTHMUS_METADATA_VALUE_LENGTH = 256

type IsthmusMetadata = Readonly<Record<string, string | number | boolean | null>>

/**
 * Enforce the metadata contract at the single emit seam. Returns the bounded bag
 * and whether anything was clipped (so the caller counts it). Keeps at most
 * {@link MAX_ISTHMUS_METADATA_KEYS} keys and clips each string value to
 * {@link MAX_ISTHMUS_METADATA_VALUE_LENGTH}. Non-string primitives pass through:
 * the payload type already forbids objects/functions, so there is nothing to
 * recurse into and no unbounded value except a long string.
 */
function boundMetadata(metadata: IsthmusMetadata | undefined): {
  bounded: IsthmusMetadata
  clipped: boolean
} {
  if (!metadata) return { bounded: {}, clipped: false }
  const keys = Object.keys(metadata)
  if (keys.length === 0) return { bounded: {}, clipped: false }

  let clipped = keys.length > MAX_ISTHMUS_METADATA_KEYS
  const boundedKeys = clipped ? keys.slice(0, MAX_ISTHMUS_METADATA_KEYS) : keys

  const out: Record<string, string | number | boolean | null> = {}
  for (const key of boundedKeys) {
    const value = metadata[key]
    if (typeof value === 'string' && value.length > MAX_ISTHMUS_METADATA_VALUE_LENGTH) {
      out[key] = value.slice(0, MAX_ISTHMUS_METADATA_VALUE_LENGTH)
      clipped = true
    } else {
      out[key] = value as string | number | boolean | null
    }
  }
  return { bounded: out, clipped }
}

/**
 * The minimal registry-entry shape the audit reads. Every layer's registry
 * (`ISTHMUS_REGISTRY`, `AI_GUARD_REGISTRY`, `CRYPTO_GUARD_REGISTRY`) yields
 * entries with at least these fields; the audit builds its payload from them.
 */
export interface GuardAuditEntry {
  readonly id: string
  readonly pillar: IsthmusPillar
  readonly bugClass: string
  readonly severity: IsthmusSeverity
  readonly event: string
  /**
   * Dispatch policy, declared once per guard in its registry. `'broadcast'` (the
   * default when omitted) fans the `IsthmusGuardTripped` event out under the
   * per-severity window. `'count-only'` classifies the guard as ATTACKER-REACHABLE
   * at high volume from unauthenticated/pre-tenant request input: the trip is
   * recorded on the counters (and the per-tenant metric bridge) but the event is
   * NEVER broadcast, so a flood of it can never consume its severity's shared
   * dispatch window and starve a co-severity security guard's alerts for OTHER
   * tenants (S3). The counter carries the volume signal; alert on
   * `multitenancy_isthmus_rejected_total` for a count-only guard.
   */
  readonly dispatchPolicy?: 'broadcast' | 'count-only'
}

/** Immutable counter snapshot for the exporter / specs (one seam, one reader). */
export interface GuardCountersSnapshot<TId extends string = string> {
  readonly guarded: ReadonlyArray<{
    pillar: IsthmusPillar
    severity: IsthmusSeverity
    value: number
  }>
  readonly rejected: ReadonlyArray<{
    id: TId
    pillar: IsthmusPillar
    severity: IsthmusSeverity
    value: number
  }>
  readonly dropped: ReadonlyArray<{
    severity: IsthmusSeverity
    reason: IsthmusDropReason
    value: number
  }>
}

export interface GuardEmitOptions {
  readonly tenantId?: string | null
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
  /**
   * Whether to broadcast the fire-and-forget `IsthmusGuardTripped` event.
   * Defaults to true. Set false to record the trip on the counters (and the
   * per-tenant metric bridge) WITHOUT dispatching an event. Use this for a
   * high-volume, lower-stakes degrade signal that belongs on a counter you alert
   * on rather than a per-event broadcast. A count-only trip touches no dispatch
   * window, so it can
   * never consume its severity's dispatch budget and crowd out a co-severity
   * guard's events.
   */
  readonly dispatch?: boolean
}

export type GuardDispatcher = (payload: IsthmusGuardTrippedPayload) => Promise<void>

/** The per-tenant integer-metric bridge (satellites only). */
export type GuardMetricSink = (
  tenantId: string,
  name: string,
  value: number
) => void | Promise<void>

export interface CreateGuardAuditOptions<TId extends string> {
  /**
   * Total lookup from an id to its registry entry. Called on the emit hot path
   * and again per snapshot row. May return undefined or throw for an
   * unregistered id. Either way the emit swallows it and counts nothing (a
   * runtime-invalid id must never throw or mutate a counter).
   */
  readonly lookup: (id: TId) => GuardAuditEntry
  /**
   * Enables the per-tenant metric bridge under this metric name. Omit for the
   * kernel (whose guard trips surface only through the shared event and its own
   * Prometheus counters, not a per-tenant integer metric). When set, `emit`
   * bridges one metric per tenantful trip via the installed sink.
   */
  readonly metricName?: string
}

/** A built guard-audit instance. All methods are free closures (safe to alias). */
export interface GuardAuditInstance<TId extends string> {
  /**
   * Whether an event of this severity may dispatch now, under that severity's
   * fixed-window budget. Pure-ish (takes `now`) so the limiter is unit-testable
   * without faking time.
   */
  allow(severity: IsthmusSeverity, now: number): boolean
  /**
   * Record a guard trip: bump the counters, bridge the per-tenant metric (if
   * configured), then dispatch the public `IsthmusGuardTripped` event
   * (best-effort, rate-limited, fire-and-forget) unless `options.dispatch` is
   * false, in which case the trip is recorded on the counters but no event is
   * broadcast. Synchronous and it NEVER throws. Call it on the line BEFORE the
   * guard's throw, never after. Must not read config: config-phase guards trip
   * before the app exists.
   */
  emit(id: TId, options?: GuardEmitOptions): void
  /** Immutable counter snapshot. Builds fresh arrays per call. */
  snapshot(): GuardCountersSnapshot<TId>
  /** Replace the dispatcher without booting an app (tests). undefined restores the default. */
  setDispatcher(fn: GuardDispatcher | undefined): void
  /** Install/detach the per-tenant metric bridge. No-op unless `metricName` was set. */
  setMetricSink(sink: GuardMetricSink | undefined): void
  /** Reset the limiter so a spec starts from a clean window. */
  resetRateLimit(): void
  /** Reset the counters so a spec asserts absolute values. */
  resetCounters(): void
}

interface SeverityWindow {
  windowStart: number
  count: number
}

/**
 * The default dispatcher resolves the public event class lazily (the
 * recordScopeBypass pattern), so importing this module never drags app
 * machinery. `BaseEvent.dispatch()` throws when the static emitter is unwired
 * (no booted app); the caller's catch absorbs that into dropped{no_emitter}.
 */
const defaultDispatcher: GuardDispatcher = async (payload) => {
  const { default: IsthmusGuardTripped } = await import('../events/isthmus_guard_tripped.js')
  await IsthmusGuardTripped.dispatch(payload)
}

/**
 * Build a guard-audit instance for one registry. Each call gets its own windows,
 * counters, dispatcher, and (optional) metric sink.
 */
export function createGuardAudit<TId extends string>(
  options: CreateGuardAuditOptions<TId>
): GuardAuditInstance<TId> {
  const { lookup, metricName } = options

  const windows = new Map<IsthmusSeverity, SeverityWindow>()

  // Monotonic in-process counters. Composite string keys keep the maps flat; the
  // snapshot re-expands them. Bumped BEFORE the rate limiter, so the totals stay
  // exact even when event dispatch drops.
  const guardedCounts = new Map<string, number>()
  const rejectedCounts = new Map<TId, number>()
  const droppedCounts = new Map<string, number>()

  let dispatcher: GuardDispatcher = defaultDispatcher
  let metricSink: GuardMetricSink | undefined

  function bump<K>(map: Map<K, number>, key: K): void {
    map.set(key, (map.get(key) ?? 0) + 1)
  }

  function allow(severity: IsthmusSeverity, now: number): boolean {
    let window = windows.get(severity)
    if (!window || now - window.windowStart >= WINDOW_MS) {
      window = { windowStart: now, count: 0 }
      windows.set(severity, window)
    }
    if (window.count >= ISTHMUS_BUDGETS[severity]) return false
    window.count++
    return true
  }

  function emit(id: TId, emitOptions: GuardEmitOptions = {}): void {
    try {
      const entry = lookup(id)
      // Reading entry.pillar/severity here means an unregistered id (undefined
      // entry, or a lookup that throws) aborts BEFORE any counter is bumped.
      // The outer catch then swallows it, so a bad id never mutates state.
      bump(guardedCounts, `${entry.pillar} ${entry.severity}`)
      bump(rejectedCounts, id)

      // The metric bridge is a counter-like signal, so it sits with the counters,
      // ahead of the rate limiter, and shares the dispatcher's sync-throw-safe
      // wrap (a synchronously-throwing sink must not escape into the reject path).
      // Fires only for tenantful trips (config/boot/mount guards are tenant-less).
      const sink = metricSink
      if (sink && metricName && emitOptions.tenantId) {
        const tenantId = emitOptions.tenantId
        void Promise.resolve()
          .then(() => sink(tenantId, metricName, 1))
          .catch(() => {})
      }

      // Count-only trip: fully recorded above (counters + metric bridge) but
      // never broadcast, so it touches no dispatch window and crowds out nothing.
      // Either the registry classifies this guard as attacker-reachable
      // (`dispatchPolicy: 'count-only'`, an S3 hardening enforced here so it can
      // never be forgotten at a call site), or the caller asked for count-only.
      if (entry.dispatchPolicy === 'count-only' || emitOptions.dispatch === false) return

      if (!allow(entry.severity, Date.now())) {
        bump(droppedCounts, `${entry.severity} rate_limited`)
        return
      }

      // Bound the metadata before it can be broadcast (the event fans out to
      // every subscribed plugin). A clip is counted, not silently dropped.
      const { bounded, clipped } = boundMetadata(emitOptions.metadata)
      if (clipped) bump(droppedCounts, `${entry.severity} metadata_bounded`)

      const payload: IsthmusGuardTrippedPayload = {
        id: entry.id,
        pillar: entry.pillar,
        bugClass: entry.bugClass,
        severity: entry.severity,
        event: entry.event,
        tenantId: emitOptions.tenantId ?? null,
        metadata: bounded,
      }
      // Fire-and-forget: the reject path never waits on listeners. Any dispatch
      // failure (unwired emitter in a unit test / pre-boot phase, a throwing
      // listener with no emitter error handler) lands in dropped{no_emitter}:
      // counted, never rethrown, never buffered. The Promise.resolve().then wrap
      // routes even a SYNCHRONOUSLY-throwing dispatcher into the same counted
      // path. A bare dispatcher(payload).catch would throw before .catch
      // attaches and the drop would vanish into the outer swallow, uncounted.
      // Capture the dispatcher reference eagerly: the audit uses whatever was
      // live when the guard tripped, so a later swap can never redirect an
      // in-flight dispatch (matters only in tests; production sets it once).
      const dispatch = dispatcher
      void Promise.resolve()
        .then(() => dispatch(payload))
        .catch(() => bump(droppedCounts, `${entry.severity} no_emitter`))
    } catch {
      // Auditing a rejection must never break the reject path.
    }
  }

  function snapshot(): GuardCountersSnapshot<TId> {
    return {
      guarded: [...guardedCounts].map(([key, value]) => {
        const [pillar, severity] = key.split(' ')
        return { pillar: pillar as IsthmusPillar, severity: severity as IsthmusSeverity, value }
      }),
      rejected: [...rejectedCounts].map(([id, value]) => {
        const entry = lookup(id)
        return { id, pillar: entry.pillar, severity: entry.severity, value }
      }),
      dropped: [...droppedCounts].map(([key, value]) => {
        const [severity, reason] = key.split(' ')
        return { severity: severity as IsthmusSeverity, reason: reason as IsthmusDropReason, value }
      }),
    }
  }

  return {
    allow,
    emit,
    snapshot,
    setDispatcher: (fn) => {
      dispatcher = fn ?? defaultDispatcher
    },
    setMetricSink: (sink) => {
      metricSink = sink
    },
    resetRateLimit: () => {
      windows.clear()
    },
    resetCounters: () => {
      guardedCounts.clear()
      rejectedCounts.clear()
      droppedCounts.clear()
    },
  }
}
