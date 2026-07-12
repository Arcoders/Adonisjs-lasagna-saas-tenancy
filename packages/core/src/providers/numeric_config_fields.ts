/**
 * The single declarative registry of numeric config tunables and their bounds,
 * the exact mirror of {@link ../providers/secret_config_fields.js SECRET_CONFIG_FIELDS}.
 * Range validation used to be a hand-written list of `atLeast(...)` / `inRange(...)`
 * calls in `assertConfigBounds`, so a new numeric tunable could ship with no bound
 * simply by no one adding a line.
 *
 * `assertConfigBounds` now iterates this list and enforces min/max on every
 * `enforce: true` field at boot, so adding a bounded tunable is one row here. The
 * `numeric_fields_bounded` architectural guard asserts that EVERY numeric leaf in
 * the config type is registered (bounded, or explicitly exempt with a reason), so
 * a new numeric field cannot ship without a conscious bounds decision.
 *
 * Coverage is checked by LEAF NAME (last path segment), matching the secrets
 * guard: several fields share a leaf (`port`, `db`), so one entry per leaf covers
 * every path carrying it.
 */
export interface NumericConfigField {
  /** Dotted path under the multitenancy config (navigated only for enforced fields). */
  path: string
  /** Whether the boot check enforces the bounds. Exempt fields are registered for guard coverage only. */
  enforce: boolean
  /** Minimum (inclusive). Required when `enforce`. */
  min?: number
  /** Maximum (inclusive). Optional; when set the field is range-checked, else lower-bounded. */
  max?: number
  /** Why an exempt (`enforce: false`) field is not bounds-checked. */
  reason?: string
}

export const NUMERIC_CONFIG_FIELDS: readonly NumericConfigField[] = [
  // --- Enforced: identical bounds to the pre-registry assertConfigBounds. ---
  { path: 'isolation.maxTenantConnections', enforce: true, min: 1 },
  { path: 'isolation.evictionGracePeriodMs', enforce: true, min: 0 },
  { path: 'tenantReadReplicas.maxReplicaConnections', enforce: true, min: 1 },
  { path: 'circuitBreaker.threshold', enforce: true, min: 1, max: 100 },
  { path: 'circuitBreaker.resetTimeout', enforce: true, min: 1 },
  { path: 'circuitBreaker.rollingCountTimeout', enforce: true, min: 1 },
  // 0 is a valid opossum value: it disables the minimum-volume gate.
  { path: 'circuitBreaker.volumeThreshold', enforce: true, min: 0 },
  { path: 'circuitBreaker.maxTrackedCircuits', enforce: true, min: 1 },
  { path: 'queue.attempts', enforce: true, min: 1 },
  { path: 'queue.defaultConcurrency', enforce: true, min: 1 },
  { path: 'queue.maxOpenQueues', enforce: true, min: 1 },
  { path: 'queue.queueIdleGraceMs', enforce: true, min: 0 },
  { path: 'resolver.cache.ttlMs', enforce: true, min: 1 },
  { path: 'resolver.cache.maxEntries', enforce: true, min: 1 },
  { path: 'plugins.limits.maxAuthorizers', enforce: true, min: 1 },
  { path: 'plugins.limits.maxMiddleware', enforce: true, min: 1 },
  { path: 'plugins.limits.maxCapabilities', enforce: true, min: 1 },
  { path: 'plugins.limits.maxSchedules', enforce: true, min: 1 },
  { path: 'plugins.limits.authorizerDeadlineMs', enforce: true, min: 1 },
  { path: 'impersonation.defaultDuration', enforce: true, min: 60 },
  { path: 'impersonation.maxDuration', enforce: true, min: 60 },
  { path: 'maintenance.retryAfterSeconds', enforce: true, min: 1 },

  // --- Exempt: registered for drift coverage, not bounds-checked. Each carries
  // why a floor would add nothing (or would risk breaking a valid config). These
  // are candidates to promote to `enforce: true` later, deliberately. ---
  {
    path: 'schemaCacheTtl',
    enforce: false,
    reason: 'schema-cache TTL; correctness-neutral, unused when the cache is off',
  },
  {
    path: 'maintenanceSchedule.backupHour',
    enforce: false,
    reason:
      'hour-of-day for the scheduled backup; a wrong hour only shifts WHEN maintenance runs, never correctness/isolation',
  },
  {
    path: 'maintenanceSchedule.migrateAllHour',
    enforce: false,
    reason: 'hour-of-day for the scheduled migrate-all; correctness-neutral like backupHour',
  },
  {
    path: 'queue.redis.port',
    enforce: false,
    reason: 'operator-managed Redis endpoint; a bad port fails loudly at connect',
  },
  {
    path: 'queue.redis.db',
    enforce: false,
    reason: 'operator-managed Redis logical DB index',
  },
  {
    path: 'cache.ttl',
    enforce: false,
    reason: 'cache TTL seconds; correctness-neutral (0 disables)',
  },
  {
    path: 'cache.redis.port',
    enforce: false,
    reason: 'operator-managed Redis endpoint; a bad port fails loudly at connect',
  },
  {
    path: 'cache.redis.db',
    enforce: false,
    reason: 'operator-managed Redis logical DB index',
  },
  {
    path: 'onboarding.wizardTtl',
    enforce: false,
    reason: 'onboarding-wizard TTL; feature-scoped and correctness-neutral',
  },
  {
    path: 'softDelete.retentionDays',
    enforce: false,
    reason: 'soft-delete retention days; any non-negative value is valid and purge is opt-in',
  },
  {
    path: 'plans.reservationTtlMs',
    enforce: false,
    reason: 'quota reservation hold TTL; a crashed-stream backstop, correctness-neutral',
  },
  {
    path: 'plans.definitions.rateLimit.limit',
    enforce: false,
    reason: 'per-plan rate-limit tunable inside plans.definitions.<name>, not a fixed config path',
  },
  {
    path: 'plans.definitions.rateLimit.windowSeconds',
    enforce: false,
    reason: 'per-plan rate-limit window inside plans.definitions.<name>, not a fixed config path',
  },
  {
    path: 'tenantReadReplicas.hosts[].port',
    enforce: false,
    reason: 'operator-managed replica endpoint; a bad port fails loudly at connect',
  },
  {
    path: 'health.tenantPoolSaturationThreshold',
    enforce: false,
    reason: '0..1 saturation ratio; defaults to doctor.poolSaturationWarnRatio',
  },
  {
    path: 'doctor.queueStalledMinutes',
    enforce: false,
    reason: 'doctor diagnostic threshold; affects report severity only, never correctness',
  },
  {
    path: 'doctor.replicaLagWarnSeconds',
    enforce: false,
    reason: 'doctor diagnostic threshold; report severity only',
  },
  {
    path: 'doctor.replicaLagErrorSeconds',
    enforce: false,
    reason: 'doctor diagnostic threshold; report severity only',
  },
  {
    path: 'doctor.longQueryWarnSeconds',
    enforce: false,
    reason: 'doctor diagnostic threshold; report severity only',
  },
  {
    path: 'doctor.longQueryErrorSeconds',
    enforce: false,
    reason: 'doctor diagnostic threshold; report severity only',
  },
  {
    path: 'doctor.poolSaturationWarnRatio',
    enforce: false,
    reason: 'doctor diagnostic 0..1 ratio; report severity only',
  },
  {
    path: 'backup.retention.tiers.intervalHours',
    enforce: false,
    reason:
      'backup satellite config (BackupRetentionConfig), not a core MultitenancyConfig tunable',
  },
  {
    path: 'backup.retention.tiers.keepLast',
    enforce: false,
    reason:
      'backup satellite config (BackupRetentionConfig), not a core MultitenancyConfig tunable',
  },
]

/** The leaf names (last path segment, minus any `[]`) covered by the registry. */
export function registeredNumericLeafNames(): Set<string> {
  return new Set(NUMERIC_CONFIG_FIELDS.map((f) => f.path.split('.').pop()!.replace(/\[\]$/, '')))
}
