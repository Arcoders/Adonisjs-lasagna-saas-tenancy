import { Exception } from '@adonisjs/core/exceptions'

/**
 * Raised when a tenant identifier is PRESENT in the request but malformed in a
 * way that signals tampering rather than absence — e.g. a `request-data`
 * tenant_id supplied as an array or object (`?tenant_id[]=a&tenant_id[]=b`)
 * instead of a string. Absence is a normal miss (fall through / 400 downstream);
 * a present-but-non-string value fails closed with this 400 so a type-confusion
 * attempt can never be coerced into a tenant id.
 */
export default class InvalidTenantIdentifierException extends Exception {
  static readonly status = 400
  static readonly code = 'E_INVALID_TENANT_IDENTIFIER'
  static readonly message = 'Tenant identifier in the request is present but not a string'
}
