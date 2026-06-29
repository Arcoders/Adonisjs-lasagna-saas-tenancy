import { Exception } from '@adonisjs/core/exceptions'

/**
 * Raised when a request cannot be matched to a known tenant during resolution. It extends the
 * AdonisJS base Exception and carries an HTTP 404 status, the stable code E_TENANT_NOT_FOUND, and
 * the default message "Tenant not found" so handlers can respond consistently.
 */
export default class TenantNotFoundException extends Exception {
  static readonly status = 404
  static readonly code = 'E_TENANT_NOT_FOUND'
  static readonly message = 'Tenant not found'
}
