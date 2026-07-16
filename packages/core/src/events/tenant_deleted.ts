import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Domain event dispatched after a tenant is permanently removed, such as when the
 * destroy command drops its schema, the uninstall job runs, or expired tenants are
 * purged. It extends the AdonisJS BaseEvent and carries the deleted tenant record as
 * a readonly `tenant` property so listeners can react to the removal, for example by
 * invalidating cached tenant resolutions.
 * @property {TenantModelContract} tenant The tenant that was deleted.
 */
export default class TenantDeleted extends BaseEvent {
  constructor(readonly tenant: TenantModelContract) {
    super()
  }
}
