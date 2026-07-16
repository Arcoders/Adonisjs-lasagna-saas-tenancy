import { Exception } from '@adonisjs/core/exceptions'

/**
 * Thrown when a tenant attempts an operation that would push a usage quota past its
 * allowed limit. Extends the AdonisJS Exception with a 429 status and the
 * E_TENANT_QUOTA_EXCEEDED code, and records the tenant id, quota name, limit, current
 * usage, and attempted increment so handlers can report exactly which threshold was breached.
 *
 * @example
 * throw new QuotaExceededException({ tenantId, quota: 'seats', limit: 10, current: 10, attempted: 1 })
 */
export default class QuotaExceededException extends Exception {
  static readonly status = 429
  static readonly code = 'E_TENANT_QUOTA_EXCEEDED'

  readonly tenantId: string
  readonly quota: string
  readonly limit: number
  readonly current: number
  readonly attempted: number

  constructor(payload: {
    tenantId: string
    quota: string
    limit: number
    current: number
    attempted: number
    message?: string
  }) {
    super(
      payload.message ??
        `Tenant ${payload.tenantId} exceeded ${payload.quota}: ${payload.current}+${payload.attempted} > ${payload.limit}`
    )
    this.tenantId = payload.tenantId
    this.quota = payload.quota
    this.limit = payload.limit
    this.current = payload.current
    this.attempted = payload.attempted
  }
}
