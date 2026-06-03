import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'
import type { BackupMetadata } from '../types/backup.js'

export default class TenantBackedUp extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly metadata: BackupMetadata
  ) {
    super()
  }
}
