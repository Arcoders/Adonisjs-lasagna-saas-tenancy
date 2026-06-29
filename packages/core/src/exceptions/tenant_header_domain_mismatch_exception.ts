import { Exception } from '@adonisjs/core/exceptions'

/**
 * Raised when an incoming request carries an `x-tenant-id` header whose tenant
 * does not match the tenant resolved from the request Host or custom domain. The
 * strict `CustomDomainMiddleware` throws it to reject a possible cross-tenant
 * hijack before any route handler runs, responding with HTTP status 400 and the
 * error code `E_TENANT_HEADER_DOMAIN_MISMATCH`.
 */
export default class TenantHeaderDomainMismatchException extends Exception {
  static readonly status = 400
  static readonly code = 'E_TENANT_HEADER_DOMAIN_MISMATCH'
  static readonly message =
    'x-tenant-id header does not match the tenant resolved from the Host header'
}
