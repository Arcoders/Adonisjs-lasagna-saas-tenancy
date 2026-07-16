import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * AdonisJS event dispatched when a tenant leaves maintenance mode and becomes
 * available again. It extends BaseEvent and carries the affected tenant as a
 * readonly constructor property, letting listeners react to a tenant resuming
 * normal operation, such as clearing maintenance banners or re-enabling traffic.
 *
 * @extends BaseEvent
 * @property tenant - The tenant that has exited maintenance, typed as TenantModelContract.
 */
export default class TenantExitedMaintenance extends BaseEvent {
  constructor(readonly tenant: TenantModelContract) {
    super()
  }
}
