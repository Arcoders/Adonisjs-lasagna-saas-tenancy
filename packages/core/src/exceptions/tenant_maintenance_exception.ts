import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

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

  async handle(error: this, ctx: HttpContext): Promise<void> {
    ctx.response
      .status(error.status)
      .header('Retry-After', String(error.retryAfterSeconds ?? 600))
      .send({ errors: [{ code: error.code, message: error.tenantMessage ?? error.message }] })
  }
}
