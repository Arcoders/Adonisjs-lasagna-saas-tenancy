import { Exception } from '@adonisjs/core/exceptions'
import { getConfig } from '../config.js'

/**
 * AdonisJS exception thrown when a request fails to supply the tenant header required to resolve the
 * current tenant. It carries HTTP status 400 and the code `E_MISSING_TENANT_HEADER`, and its
 * constructor builds a message naming the configured `tenantHeaderKey`, falling back to a generic
 * message when configuration is not yet available.
 */
export default class MissingTenantHeaderException extends Exception {
  static readonly status = 400
  static readonly code = 'E_MISSING_TENANT_HEADER'
  static readonly message = 'Missing tenant header'

  constructor() {
    let message = MissingTenantHeaderException.message
    try {
      message = `Missing ${getConfig().tenantHeaderKey} header`
    } catch {}
    super(message, {
      status: MissingTenantHeaderException.status,
      code: MissingTenantHeaderException.code,
    })
  }
}
