import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

export default class TenantSuspended extends BaseEvent {
  constructor(readonly tenant: TenantModelContract) {
    super()
  }
}
