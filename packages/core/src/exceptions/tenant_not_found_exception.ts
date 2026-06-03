import { Exception } from '@adonisjs/core/exceptions'

export default class TenantNotFoundException extends Exception {
  static readonly status = 404
  static readonly code = 'E_TENANT_NOT_FOUND'
  static readonly message = 'Tenant not found'
}
