import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * AdonisJS event extending BaseEvent that signals a tenant has been activated, carrying the
 * affected tenant model on its readonly `tenant` property. It is dispatched by the
 * `tenant:activate` command after a suspended or failed tenant is moved back to active, and
 * listeners such as the resolution-cache invalidator react to it to refresh cached state.
 *
 * @see {@link TenantModelContract} for the shape of the carried tenant.
 */
export default class TenantActivated extends BaseEvent {
  constructor(readonly tenant: TenantModelContract) {
    super()
  }
}
