import { Exception } from '@adonisjs/core/exceptions'

export default class TenantNotReadyException extends Exception {
  static readonly status = 503
  static readonly code = 'E_TENANT_NOT_READY'
  static readonly message = 'This tenant is not yet ready. Please try again shortly'
}
