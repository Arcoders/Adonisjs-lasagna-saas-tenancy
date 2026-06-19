import { Exception } from '@adonisjs/core/exceptions'

export default class TenantAccessForbiddenException extends Exception {
  static readonly status = 403
  static readonly code = 'E_TENANT_ACCESS_FORBIDDEN'
  static readonly message = 'Not authorized for this tenant'
}
