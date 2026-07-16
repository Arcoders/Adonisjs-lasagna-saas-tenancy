import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * String literal union describing the direction in which a tenant's schema migrations ran, either
 * 'up' to apply pending migrations or 'down' to roll them back. It is the typed value carried by the
 * `direction` field on the TenantMigrated event so listeners can distinguish a forward migration from
 * a rollback when reacting to schema changes for a tenant.
 */
export type TenantMigrationDirection = 'up' | 'down'

/**
 * AdonisJS event dispatched after a tenant's schema migrations have been applied,
 * carrying the affected tenant model and the migration direction ('up' for forward
 * migrations run by the migrate and fresh commands, 'down' for rollbacks). Listeners
 * can subscribe to react to per-tenant schema changes during migration commands.
 *
 * @property {TenantModelContract} tenant - The tenant whose schema was migrated.
 * @property {TenantMigrationDirection} direction - Whether the migration ran up or down.
 */
export default class TenantMigrated extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly direction: TenantMigrationDirection
  ) {
    super()
  }
}
