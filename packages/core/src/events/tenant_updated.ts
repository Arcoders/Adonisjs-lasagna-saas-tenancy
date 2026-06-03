import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

export default class TenantUpdated extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly changes: Record<string, { from: unknown; to: unknown }>
  ) {
    super()
  }
}
