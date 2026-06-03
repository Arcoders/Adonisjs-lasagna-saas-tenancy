import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

export default class TenantEnteredMaintenance extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly message: string | null
  ) {
    super()
  }
}
