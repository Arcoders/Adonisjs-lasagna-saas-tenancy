import { Exception } from '@adonisjs/core/exceptions'

export default class TenantSuspendedException extends Exception {
  static readonly status = 403
  static readonly code = 'E_TENANT_SUSPENDED'
  static readonly message = 'This tenant account has been suspended'
}
