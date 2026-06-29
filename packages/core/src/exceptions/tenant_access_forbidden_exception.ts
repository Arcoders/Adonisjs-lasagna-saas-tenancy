import { Exception } from '@adonisjs/core/exceptions'

/**
 * Exception thrown when a request is denied access to the resolved tenant, for
 * example after a membership or authorization check rejects the caller. It
 * extends the AdonisJS base Exception and carries an HTTP 403 status, the
 * stable error code E_TENANT_ACCESS_FORBIDDEN, and a default human-readable
 * message identifying the access failure.
 */
export default class TenantAccessForbiddenException extends Exception {
  static readonly status = 403
  static readonly code = 'E_TENANT_ACCESS_FORBIDDEN'
  static readonly message = 'Not authorized for this tenant'
}
