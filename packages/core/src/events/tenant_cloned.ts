import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'
import type { CloneResult } from '../types/backup.js'

/**
 * Lifecycle event dispatched after one tenant's schema is cloned into another. It
 * extends AdonisJS `BaseEvent` and carries the `source` and `destination` tenant
 * models alongside the `CloneResult`, which records how many tables and rows were
 * copied, so listeners can react to a completed tenant clone operation.
 */
export default class TenantCloned extends BaseEvent {
  constructor(
    readonly source: TenantModelContract,
    readonly destination: TenantModelContract,
    readonly result: CloneResult
  ) {
    super()
  }
}
