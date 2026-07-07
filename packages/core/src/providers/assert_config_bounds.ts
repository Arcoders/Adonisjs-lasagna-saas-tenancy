import type { MultitenancyConfig } from '../types/config.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'
import { isProductionNodeEnv } from '../utils/env.js'
import { resolutionSafetyAudit } from './resolution_safety.js'
import { assertResolverChain } from './resolver_chain.js'
import { SECRET_CONFIG_FIELDS } from './secret_config_fields.js'

/**
 * Range-check the numeric tunables at boot. The provider's `#assertConfigShape`
 * proves the required fields exist and the strategy is known; this catches the
 * next tier of deploy mistakes (a zero pool size, a negative grace window, a
 * circuit threshold outside 1..100) before they surface later as eviction churn,
 * a dead pool, or a breaker that never trips.
 *
 * Every check is keyed on presence: an omitted tunable keeps its documented
 * default and is skipped. Kept as a pure function (not a provider method) so it
 * can be unit-tested without booting an Ignitor, matching `validate_driver_choice`.
 */
/** Read a dotted config path (e.g. `impersonation.secret`), null-safe at each hop. */
function readConfigPath(config: MultitenancyConfig, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
      config
    )
}

export function assertConfigBounds(config: MultitenancyConfig): void {
  const fail = (path: string, rule: string, value: unknown): never => {
    // Single chokepoint for every bounds violation, so one emit covers them all.
    emitIsthmusEvent('guard.config_bounds', { metadata: { path, rule } })
    throw new Error(`multitenancy.${path} must be ${rule}, got ${String(value)}.`)
  }
  const atLeast = (value: number | undefined, path: string, min: number): void => {
    if (value == null) return
    if (!Number.isFinite(value) || value < min) fail(path, `>= ${min}`, value)
  }
  const inRange = (value: number | undefined, path: string, min: number, max: number): void => {
    if (value == null) return
    if (!Number.isFinite(value) || value < min || value > max) {
      fail(path, `between ${min} and ${max}`, value)
    }
  }

  atLeast(config.isolation?.maxTenantConnections, 'isolation.maxTenantConnections', 1)
  atLeast(config.isolation?.evictionGracePeriodMs, 'isolation.evictionGracePeriodMs', 0)

  atLeast(
    config.tenantReadReplicas?.maxReplicaConnections,
    'tenantReadReplicas.maxReplicaConnections',
    1
  )

  const cb = config.circuitBreaker
  if (cb) {
    inRange(cb.threshold, 'circuitBreaker.threshold', 1, 100)
    atLeast(cb.resetTimeout, 'circuitBreaker.resetTimeout', 1)
    atLeast(cb.rollingCountTimeout, 'circuitBreaker.rollingCountTimeout', 1)
    // 0 is a valid opossum value: it disables the minimum-volume gate so the
    // breaker can trip from the first request. Only negatives are wrong.
    atLeast(cb.volumeThreshold, 'circuitBreaker.volumeThreshold', 0)
    atLeast(cb.maxTrackedCircuits, 'circuitBreaker.maxTrackedCircuits', 1)
  }

  const q = config.queue
  if (q) {
    atLeast(q.attempts, 'queue.attempts', 1)
    atLeast(q.defaultConcurrency, 'queue.defaultConcurrency', 1)
    atLeast(q.maxOpenQueues, 'queue.maxOpenQueues', 1)
    atLeast(q.queueIdleGraceMs, 'queue.queueIdleGraceMs', 0)
  }

  atLeast(config.resolver?.cache?.ttlMs, 'resolver.cache.ttlMs', 1)
  atLeast(config.resolver?.cache?.maxEntries, 'resolver.cache.maxEntries', 1)

  // Plugin-platform request-path caps. These validate the CONFIGURED numbers are
  // sane (a 0/negative cap is a deploy mistake). The actual count enforcement —
  // registered entries vs cap — happens in the provider's start(), once every
  // plugin has registered (see assert_plugin_limits.ts).
  const pl = config.plugins?.limits
  if (pl) {
    atLeast(pl.maxAuthorizers, 'plugins.limits.maxAuthorizers', 1)
    atLeast(pl.maxMiddleware, 'plugins.limits.maxMiddleware', 1)
    atLeast(pl.maxCapabilities, 'plugins.limits.maxCapabilities', 1)
    atLeast(pl.authorizerDeadlineMs, 'plugins.limits.authorizerDeadlineMs', 1)
  }

  const imp = config.impersonation
  if (imp) {
    atLeast(imp.defaultDuration, 'impersonation.defaultDuration', 60)
    atLeast(imp.maxDuration, 'impersonation.maxDuration', 60)
    if (
      imp.defaultDuration != null &&
      imp.maxDuration != null &&
      imp.maxDuration < imp.defaultDuration
    ) {
      fail('impersonation.maxDuration', '>= impersonation.defaultDuration', imp.maxDuration)
    }
  }

  // A resolverChain entry that names no built-in / inline resolver is a deploy
  // mistake that would otherwise pick the wrong (or no) tenant; fail at boot.
  assertResolverChain(config)

  atLeast(config.maintenance?.retryAfterSeconds, 'maintenance.retryAfterSeconds', 1)

  // Secret-strength floors, single-sourced from SECRET_CONFIG_FIELDS so every
  // standing secret (impersonation HMAC, maintenance bypass token, and any future
  // one) clears the same bar at boot. A field is REQUIRED when its `requiredWhen`
  // says so (the impersonation secret once the block is present); otherwise it is
  // only length-checked when set. Exempt (infra-credential) fields are skipped.
  for (const field of SECRET_CONFIG_FIELDS) {
    if (!field.enforce) continue
    const value = readConfigPath(config, field.path)
    const min = field.minLength ?? 0
    if (value == null) {
      if (field.requiredWhen?.(config)) {
        fail(field.path, `set and at least ${min} characters`, 'missing')
      }
      continue
    }
    if (typeof value !== 'string' || value.length < min) {
      fail(
        field.path,
        `at least ${min} characters`,
        typeof value === 'string' ? `${value.length} chars` : typeof value
      )
    }
  }

  // Resolution-safety gate. Two high-severity cross-tenant exposures are enforced
  // through one audit: a client-controlled strategy with no membership gate
  // (IDOR) and a host strategy with no expectedHostSuffix allowlist (spoofable
  // tenant-hop). In production we fail closed at boot on any finding; in dev the
  // provider logs the same messages as warnings (it has the container logger).
  // Acknowledgement (authorizeTenantAccess / acknowledgeNoMembershipGate) is
  // honored inside the audit, so an accepted posture produces no finding.
  if (isProductionNodeEnv()) {
    const risks = resolutionSafetyAudit(config)
    if (risks.length > 0) {
      emitIsthmusEvent('guard.resolution_safety', {
        metadata: { codes: risks.map((r) => r.code).join(',') },
      })
      throw new Error(risks.map((r) => r.message).join('\n\n'))
    }
  }
}
