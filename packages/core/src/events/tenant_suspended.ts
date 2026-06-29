import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Domain event dispatched when a tenant transitions into the suspended
 * lifecycle state. It extends AdonisJS `BaseEvent` and carries the affected
 * tenant model (typed as `TenantModelContract`) on its readonly `tenant`
 * property, so listeners can react to the suspension, for example pausing
 * jobs, revoking access, or notifying the owner.
 *
 * @see TenantModelContract
 */
export default class TenantSuspended extends BaseEvent {
  constructor(readonly tenant: TenantModelContract) {
    super()
  }
}
