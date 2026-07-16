import { Exception } from '@adonisjs/core/exceptions'

/**
 * Exception raised when an impersonation token is invalid or expired, extending the AdonisJS
 * base Exception. It carries an HTTP 401 status, the machine-readable code
 * E_IMPERSONATION_TOKEN_INVALID, and a default human-readable message so callers can reject
 * unauthenticated impersonation attempts with a consistent error response.
 */
export default class ImpersonationInvalidException extends Exception {
  static readonly status = 401
  static readonly code = 'E_IMPERSONATION_TOKEN_INVALID'
  static readonly message = 'Invalid or expired impersonation token'
}
