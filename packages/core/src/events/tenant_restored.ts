import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Lifecycle event emitted after a tenant's data has been restored from a named backup
 * archive. It extends AdonisJS `BaseEvent` and carries the restored `tenant` model along
 * with the `fileName` of the dump it was restored from, letting listeners audit, log, or
 * react to a completed restore. It is dispatched by the backup satellite's `RestoreTenant`
 * job once `BackupService.restore` finishes, and signals a backup restore rather than an
 * un-delete of a soft-deleted tenant.
 *
 * @property tenant - The tenant model that was restored from the backup.
 * @property fileName - Name of the backup archive the tenant was restored from.
 */
export default class TenantRestored extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly fileName: string
  ) {
    super()
  }
}
