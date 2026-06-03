import { Exception } from '@adonisjs/core/exceptions'
import { getConfig } from '../config.js'

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
