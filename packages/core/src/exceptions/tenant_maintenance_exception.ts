import { Exception } from '@adonisjs/core/exceptions'

export default class TenantMaintenanceException extends Exception {
  static readonly status = 503
  static readonly code = 'E_TENANT_MAINTENANCE'
  static readonly message = 'This tenant is currently under maintenance'

  /**
   * Optional retry-after hint in seconds. Set by the middleware so error
   * renderers can surface a `Retry-After` header.
   */
  retryAfterSeconds?: number
  /** User-facing message override coming from the tenant record. */
  tenantMessage: string | null = null
}
