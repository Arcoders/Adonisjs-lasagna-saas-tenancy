import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'
import type { BackupMetadata } from '../types/backup.js'

/**
 * Lifecycle event dispatched after a tenant's schema has been successfully backed up to an
 * archive. Extends the AdonisJS `BaseEvent` and carries the backed-up `tenant` model instance
 * along with the `BackupMetadata` (archive file path, size, timestamp, tenant id, and schema
 * name) so listeners can react to a completed backup.
 */
export default class TenantBackedUp extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly metadata: BackupMetadata
  ) {
    super()
  }
}
