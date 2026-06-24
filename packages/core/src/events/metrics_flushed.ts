import { BaseEvent } from '@adonisjs/core/events'

export interface MetricsFlushedPayload {
  /** The period bucket that was flushed (YYYY-MM-DD, UTC). */
  period: string
  /** Distinct tenants written in this flush, when the command computed it. */
  tenantCount?: number
}

/**
 * Emitted by the `tenant:metrics:flush` command after BOTH the built-in and custom
 * counters have been flushed to the backoffice tables. Lets read-side caches react
 * to fresh data — the `reporting` satellite optionally subscribes to clear its
 * dashboard cache. Best-effort: a throwing listener never fails the flush.
 */
export default class MetricsFlushed extends BaseEvent {
  constructor(readonly payload: MetricsFlushedPayload) {
    super()
  }
}
