/**
 * Single source of truth for the kernel's observability vocabulary: span names,
 * span/event attribute keys, and the Prometheus gauge names. Dashboards, alerts,
 * and the future AI satellite's `ai.stream` span link against these exact
 * strings, so they are a CONTRACT — renaming one is a breaking change and must be
 * a single, reviewable edit here (pinned by `check-observability-names.mjs`).
 *
 * Two disciplines are encoded:
 *  - Names never appear inline elsewhere; instrumentation imports them from here.
 *  - Attribute keys are a fixed, non-PII allowlist (`OBS_ATTR`). Only ids, counts,
 *    and outcomes — never tenant content. The telemetry unit spec asserts every
 *    emitted attribute key is in this set, so a future `setAttribute('prompt', …)`
 *    fails the suite.
 */

/** OpenTelemetry span names emitted by the kernel. */
export const OBS_SPAN = {
  quotaReserve: 'quota.reserve',
  quotaRelease: 'quota.release',
  extensionExecute: 'extension.execute',
} as const

/** Span-event names. `settle` rides the caller's active span (per-fragment; never its own span). */
export const OBS_EVENT = {
  holdPlaced: 'hold_placed',
  refused: 'refused',
  settle: 'settle',
  release: 'release',
} as const

/**
 * The complete non-PII allowlist of span/event attribute keys the kernel emits.
 * Ids, counts, and outcomes only. Enforced behaviorally by the telemetry spec.
 */
export const OBS_ATTR = {
  tenantId: 'tenant.id',
  quota: 'quota',
  worstCase: 'worst_case',
  outcome: 'outcome',
  effectiveTenant: 'effective_tenant',
  effectiveCeiling: 'effective_ceiling',
  scope: 'scope',
  delta: 'delta',
  clamped: 'clamped',
  freed: 'freed',
  extension: 'extension',
} as const

/** The set of allowed attribute keys, for the allowlist assertion in tests. */
export const OBS_ATTR_ALLOWLIST: readonly string[] = Object.values(OBS_ATTR)

/** Reserve `outcome` attribute values. */
export const RESERVE_OUTCOME = {
  ok: 'ok',
  overBudget: 'over_budget',
  ceiling: 'ceiling',
} as const

/** `extension.execute` `outcome` attribute values. */
export const EXTENSION_OUTCOME = {
  completed: 'completed',
  timeout: 'timeout',
  aborted: 'aborted',
  rateLimited: 'rate_limited',
  rateLimitUnavailable: 'rate_limit_unavailable',
  error: 'error',
} as const

/**
 * Prometheus gauge names for the operator-global ceiling. Operator-level only —
 * labelled by `quota`, NEVER by `tenant_id` (a cardinality bomb). Per-tenant
 * budget detail lives in traces/logs, not in the scrape.
 */
export const QUOTA_CEILING_GAUGE = {
  committed: 'multitenancy_quota_ceiling_committed',
  outstanding: 'multitenancy_quota_ceiling_outstanding',
  utilization: 'multitenancy_quota_ceiling_utilization_ratio',
} as const
