import { Exception } from '@adonisjs/core/exceptions'

export default class ImpersonationInvalidException extends Exception {
  static readonly status = 401
  static readonly code = 'E_IMPERSONATION_TOKEN_INVALID'
  static readonly message = 'Invalid or expired impersonation token'
}
