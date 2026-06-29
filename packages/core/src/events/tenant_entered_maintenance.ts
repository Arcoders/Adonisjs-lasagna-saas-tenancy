import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Domain event dispatched when a tenant transitions into maintenance mode, extending the
 * AdonisJS BaseEvent so listeners can react through the event emitter. It carries the affected
 * tenant model and an optional human-readable message explaining the maintenance window, and is
 * consumed by listeners such as the resolution-cache invalidation provider.
 *
 * @property tenant - The tenant model that entered maintenance mode.
 * @property message - An optional message describing the maintenance, or null when none was given.
 */
export default class TenantEnteredMaintenance extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly message: string | null
  ) {
    super()
  }
}
