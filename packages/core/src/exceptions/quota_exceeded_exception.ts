import { Exception } from '@adonisjs/core/exceptions'

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
