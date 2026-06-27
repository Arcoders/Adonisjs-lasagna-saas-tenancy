import type { MultitenancyConfig } from '../types/config.js'
import { isProductionNodeEnv } from '../utils/env.js'
import { hostTrustWarning } from './assert_host_trust.js'
import { assertResolverChain } from './resolver_chain.js'

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
export function assertConfigBounds(config: MultitenancyConfig): void {
  const fail = (path: string, rule: string, value: unknown): never => {
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

  // The maintenance bypass token is a standing shared secret that lets a request
  // skip the maintenance gate on a tenant deliberately taken offline (mid-migration,
  // etc.). A short token is brute-forceable, and the constant-time compare leaks
  // length, so require real entropy (matches the impersonation.secret floor).
  const bypassToken = config.maintenance?.bypassToken
  if (bypassToken != null && bypassToken.length < 32) {
    fail('maintenance.bypassToken', 'at least 32 characters', `${bypassToken.length} chars`)
  }

  // Host-trust gate: a host-based strategy with no expectedHostSuffix is a
  // spoofable tenant-hop. In production we fail closed at boot; in dev the
  // provider logs the same message as a warning (it has the container logger).
  if (isProductionNodeEnv()) {
    const hostTrust = hostTrustWarning(config)
    if (hostTrust) throw new Error(hostTrust)
  }
}
