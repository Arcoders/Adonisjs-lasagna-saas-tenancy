import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

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
