import { Exception } from '@adonisjs/core/exceptions'

/**
 * Thrown for a permanent, operator-fix-required isolation misconfiguration. For
 * example, the per-tenant template connection is missing from `config/database.ts`.
 *
 * It carries a 500, deliberately NOT a 503: retrying will not help until the
 * deploy is fixed, so the request path must not mask it as a transient
 * "dependency unavailable" backoff. Because it declares an HTTP status, the
 * `request.tenant()` macro and the universal middleware re-throw it as-is
 * instead of rewriting it into a retry-able 503.
 */
export default class IsolationConfigException extends Exception {
  static readonly status = 500
  static readonly code = 'E_ISOLATION_CONFIG'
}
