import { Exception } from '@adonisjs/core/exceptions'

/**
 * Thrown by `connect()` on the per-tenant drivers (schema-pg / database-pg) when
 * `isolation.enforceConnectionCap` is on, `maxTenantConnections` is reached, and
 * every open connection is still inside the eviction grace window (so none can
 * be evicted without severing an in-flight request). Renders a 503 so the caller
 * can retry once a slot frees up, instead of silently exceeding the cap.
 */
export default class TenantConnectionLimitException extends Exception {
  static readonly status = 503
  static readonly code = 'E_TENANT_CONNECTION_LIMIT'
  static readonly message = 'Tenant connection limit reached. Please retry shortly.'
}
