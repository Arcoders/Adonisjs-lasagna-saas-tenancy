import { BaseEvent } from '@adonisjs/core/events'
import type { FailurePolicy } from '../types/config.js'

export interface DependencyDegradedPayload {
  /** Logical dependency name, like `'redis'`, `'postgres'` or `'stripe'`. */
  dependency: string
  /** Operation label, e.g. `'quota.consume'`. */
  operation: string
  tenantId?: string | null
  /** Policy that was applied when the dependency failed. */
  policy: FailurePolicy
  /** Best-effort classification of the underlying error. */
  errorCode: string
}

/**
 * Emitted by `ResilienceService.run()` whenever a wrapped dependency call fails
 * and the configured degradation policy kicks in. Subscribe to it to drive
 * paging and alarms: a burst of these means a backing service like Redis or
 * Postgres is down. Emission is gated by `config.resilience.observe`, which
 * defaults to `true`.
 */
export default class DependencyDegraded extends BaseEvent {
  constructor(readonly payload: DependencyDegradedPayload) {
    super()
  }
}
