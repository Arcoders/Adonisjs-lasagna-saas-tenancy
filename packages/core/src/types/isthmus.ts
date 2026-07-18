/**
 * Public vocabulary of the Isthmus, the consolidation layer that names,
 * registers, and instruments the package's fail-closed guards. Hosts consume
 * these types when subscribing to the `IsthmusGuardTripped` event; the registry
 * and the emit machinery themselves are internal (see `src/isthmus/`).
 */

/** Which of the three Isthmus pillars a guard belongs to. */
export type IsthmusPillar = 'guard' | 'seal' | 'audit'

/** Alerting severity carried on every guard-tripped event. */
export type IsthmusSeverity = 'critical' | 'high' | 'warn' | 'info'

/** Whether the guard rejects (closed) or degrades/records (open) on a violation. */
export type IsthmusFailMode = 'closed' | 'open'

/**
 * When a guard trips: `config` guards run at register()/boot()/start() and
 * abort the deploy; `runtime` guards run per request/job/route registration.
 */
export type IsthmusPhase = 'config' | 'runtime'

/** What kind of evidence justifies a registry entry (thinness discipline). */
export type IsthmusEvidenceKind = 'cve' | 'incident' | 'inherent-risk' | 'invariant'

/**
 * Why a dispatch was dropped or clipped: `rate_limited` (the per-severity window
 * budget was exhausted), `no_emitter` (no booted app / the emitter was
 * unavailable), or `metadata_bounded` (the broadcast metadata exceeded the fixed
 * contract and was truncated before it went out). Counters are never dropped,
 * only the event dispatch (or, for `metadata_bounded`, part of its payload) is,
 * so a clip is still recorded here and nothing is silently lost.
 */
export type IsthmusDropReason = 'rate_limited' | 'no_emitter' | 'metadata_bounded'

/** The documented reason a guard exists. Required and non-empty on every entry. */
export interface IsthmusEvidence {
  readonly kind: IsthmusEvidenceKind
  readonly ref: string
}

/**
 * Payload carried by the public `IsthmusGuardTripped` event, dispatched
 * (best-effort, rate-limited) whenever a registered guard rejects. All fields
 * except `tenantId`/`metadata` come verbatim from the guard's registry entry.
 */
export interface IsthmusGuardTrippedPayload {
  readonly id: string
  readonly pillar: IsthmusPillar
  readonly bugClass: string
  readonly severity: IsthmusSeverity
  readonly event: string
  readonly tenantId: string | null
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>
}
