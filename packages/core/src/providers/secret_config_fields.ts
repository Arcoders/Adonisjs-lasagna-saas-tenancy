import type { MultitenancyConfig } from '../types/config.js'

/**
 * The single declarative registry of secret-bearing config fields. Strength
 * validation used to be scattered (the impersonation secret had its own boot
 * check in the provider; the maintenance bypass token had an inline check in
 * `assertConfigBounds`), so each new secret risked a bespoke check or none.
 *
 * `assertConfigBounds` now iterates this list and enforces a minimum length on
 * every `enforce: true` field at boot, so adding a secret config means adding one
 * row here, nothing more. The `secret_fields_registered` architectural guard
 * asserts that every config field whose name looks like a secret appears here
 * (enforced or explicitly exempt), so a new secret cannot be added without a
 * conscious strength decision.
 */
export interface SecretConfigField {
  /** Dotted path under the multitenancy config (navigated only for enforced fields). */
  path: string
  /** Minimum character length for an enforced field. */
  minLength?: number
  /** Whether the boot check enforces the floor. Exempt fields are registered for guard coverage only. */
  enforce: boolean
  /** When present, the field is REQUIRED (not just length-checked) if this returns true. */
  requiredWhen?: (config: MultitenancyConfig) => boolean
  /** Why an exempt (`enforce: false`) field is not length-checked. */
  reason?: string
}

export const SECRET_CONFIG_FIELDS: readonly SecretConfigField[] = [
  {
    // HMAC secret for impersonation tokens. Required once the host opts into
    // impersonation; the service keeps a use-time backstop, but failing at boot
    // means a bad deploy never reaches the first admin request.
    path: 'impersonation.secret',
    minLength: 32,
    enforce: true,
    requiredWhen: (config) => config.impersonation != null,
  },
  {
    // Standing shared secret that lets a request skip the maintenance gate.
    // Optional, but if set it must have real entropy (a short token is
    // brute-forceable and the constant-time compare leaks length).
    path: 'maintenance.bypassToken',
    minLength: 32,
    enforce: true,
  },
  // Infra credentials are operator/provider-managed (often shorter than 32 and
  // not chosen by the application), so they are registered here for guard
  // coverage but NOT length-enforced: a floor would break real deployments using
  // a provider-generated credential, and the threat (a weak app-chosen secret)
  // does not apply to a credential the operator does not pick.
  {
    path: 'queue.redis.password',
    enforce: false,
    reason: 'operator/provider-managed Redis credential',
  },
  {
    path: 'cache.redis.password',
    enforce: false,
    reason: 'operator/provider-managed Redis credential',
  },
  {
    path: 'tenantReadReplicas.hosts[].password',
    enforce: false,
    reason: 'operator/provider-managed PostgreSQL replica credential',
  },
]

/** The leaf names (last path segment, minus any `[]`) covered by the registry. */
export function registeredSecretLeafNames(): Set<string> {
  return new Set(SECRET_CONFIG_FIELDS.map((f) => f.path.split('.').pop()!.replace(/\[\]$/, '')))
}
