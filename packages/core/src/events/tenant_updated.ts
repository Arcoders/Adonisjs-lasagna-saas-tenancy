import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Lifecycle event dispatched when an existing tenant record is mutated. It extends the
 * AdonisJS `BaseEvent` and carries the affected tenant model alongside a `changes` map that
 * records each altered field together with its previous (`from`) and new (`to`) value. The
 * package subscribes to this event to invalidate the in-process tenant resolution cache so a
 * status or attribute change takes effect on the current pod immediately rather than waiting
 * out the cache TTL.
 *
 * @property tenant - The tenant model instance after the update was applied.
 * @property changes - Map keyed by field name to its `from`/`to` value pair describing what changed.
 */
export default class TenantUpdated extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly changes: Record<string, { from: unknown; to: unknown }>
  ) {
    super()
  }
}
