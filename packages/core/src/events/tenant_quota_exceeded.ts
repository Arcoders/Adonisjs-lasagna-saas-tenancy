import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * AdonisJS event dispatched when a tenant breaches one of its configured usage quotas. It extends
 * BaseEvent and carries the offending tenant model along with the quota name, its allowed limit,
 * the current usage, and the value that was attempted, letting listeners react to or report the overage.
 *
 * @property tenant - the tenant model that exceeded the quota
 * @property quota - the name of the quota that was exceeded
 * @property limit - the configured maximum allowed for the quota
 * @property current - the current usage recorded before the attempt
 * @property attempted - the usage value that triggered the breach
 */
export default class TenantQuotaExceeded extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly quota: string,
    readonly limit: number,
    readonly current: number,
    readonly attempted: number
  ) {
    super()
  }
}
