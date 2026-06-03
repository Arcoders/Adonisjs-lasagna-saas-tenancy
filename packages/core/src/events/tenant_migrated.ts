import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

export type TenantMigrationDirection = 'up' | 'down'

export default class TenantMigrated extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly direction: TenantMigrationDirection
  ) {
    super()
  }
}
