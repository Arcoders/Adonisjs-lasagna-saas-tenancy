import type { MultitenancyConfig } from '../types/config.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'
import { isDevOrTestNodeEnv } from '../utils/env.js'
import { resolutionSafetyAudit } from './resolution_safety.js'
import { assertResolverChain } from './resolver_chain.js'
import { SECRET_CONFIG_FIELDS } from './secret_config_fields.js'
import { NUMERIC_CONFIG_FIELDS } from './numeric_config_fields.js'

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

export function assertConfigBounds(
  config: MultitenancyConfig,
  options?: { inDevOrTest?: boolean }
): void {
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

  // Numeric bounds, single-sourced from NUMERIC_CONFIG_FIELDS so every tunable
  // clears the same bar at boot and a new one cannot ship unbounded (the
  // `numeric_fields_bounded` guard requires every numeric leaf to be registered
  // or exempt). A field is checked only when present (an omitted tunable keeps
  // its documented default). Exempt (`enforce: false`) fields are skipped.
  for (const field of NUMERIC_CONFIG_FIELDS) {
    if (!field.enforce) continue
    const value = readConfigPath(config, field.path) as number | undefined
    if (value == null) continue
    if (field.max !== undefined) inRange(value, field.path, field.min!, field.max)
    else atLeast(value, field.path, field.min!)
  }

  // Cross-field invariant that a per-field bound cannot express: the hard upper
  // bound must not sit below the default.
  const imp = config.impersonation
  if (
    imp?.defaultDuration != null &&
    imp?.maxDuration != null &&
    imp.maxDuration < imp.defaultDuration
  ) {
    fail('impersonation.maxDuration', '>= impersonation.defaultDuration', imp.maxDuration)
  }

  // A resolverChain entry that names no built-in / inline resolver is a deploy
  // mistake that would otherwise pick the wrong (or no) tenant; fail at boot.
  assertResolverChain(config)

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
  // tenant-hop). The gate fails CLOSED everywhere EXCEPT a recognized dev/test
  // env: production, staging, an unknown NODE_ENV, or unset all hard-fail at boot
  // on any finding, so an insecure resolution posture never ships on a warning
  // alone. In dev/test the provider logs the same messages as warnings instead
  // (it has the container logger). "dev/test" is the app's own verdict when the
  // provider calls this (`app.inDev || app.inTest`); the NODE_ENV read is the
  // fallback for direct callers. Acknowledgement (authorizeTenantAccess /
  // acknowledgeNoMembershipGate) is honored inside the audit, so an accepted
  // posture produces no finding.
  const inDevOrTest = options?.inDevOrTest ?? isDevOrTestNodeEnv()
  if (!inDevOrTest) {
    const risks = resolutionSafetyAudit(config)
    if (risks.length > 0) {
      emitIsthmusEvent('guard.resolution_safety', {
        metadata: { codes: risks.map((r) => r.code).join(',') },
      })
      throw new Error(risks.map((r) => r.message).join('\n\n'))
    }
  }
}
