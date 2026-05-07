import { Exception } from '@adonisjs/core/exceptions'

export default class TenantHeaderDomainMismatchException extends Exception {
  static readonly status = 400
  static readonly code = 'E_TENANT_HEADER_DOMAIN_MISMATCH'
  static readonly message =
    'x-tenant-id header does not match the tenant resolved from the Host header'
}
