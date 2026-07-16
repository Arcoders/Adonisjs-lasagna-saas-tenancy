import { Exception } from '@adonisjs/core/exceptions'

/**
 * Exception thrown when a tenant exists but its schema or resources are not yet
 * provisioned and available to serve the current request. It extends the AdonisJS
 * base Exception and carries an HTTP 503 status, the code E_TENANT_NOT_READY, and a
 * default message asking the caller to retry shortly, signalling a transient
 * unavailable state rather than a permanent failure.
 */
export default class TenantNotReadyException extends Exception {
  static readonly status = 503
  static readonly code = 'E_TENANT_NOT_READY'
  static readonly message = 'This tenant is not yet ready. Please try again shortly'
}
