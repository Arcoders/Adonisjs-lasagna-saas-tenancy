import { Exception } from '@adonisjs/core/exceptions'

/**
 * Exception thrown when a request targets a tenant whose account has been suspended. It extends the
 * AdonisJS base Exception and carries an HTTP 403 status, the stable code 'E_TENANT_SUSPENDED', and a
 * default message so the framework can render a forbidden response for the blocked tenant.
 */
export default class TenantSuspendedException extends Exception {
  static readonly status = 403
  static readonly code = 'E_TENANT_SUSPENDED'
  static readonly message = 'This tenant account has been suspended'
}
