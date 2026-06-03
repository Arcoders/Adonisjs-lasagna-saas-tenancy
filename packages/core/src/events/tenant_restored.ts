import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

export default class TenantRestored extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly fileName: string
  ) {
    super()
  }
}
