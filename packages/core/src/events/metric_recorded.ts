import { BaseEvent } from '@adonisjs/core/events'

export interface MetricRecordedPayload {
  tenantId: string
  /** The host-defined metric name (safe identifier). */
  name: string
  /** The integer amount recorded for this emit. */
  value: number
  /** The period bucket the value was recorded into (YYYY-MM-DD, UTC). */
  period: string
}

/**
 * Emitted by `MetricsService.emitMetric()` after a custom named metric is
 * recorded to Redis. Other satellites and host code can subscribe
 * (`emitter.on(MetricRecorded, …)`) to react to domain metrics — e.g. to mirror
 * a value into another store or trigger an alert. Emission is best-effort: a
 * throwing listener never breaks the caller.
 */
export default class MetricRecorded extends BaseEvent {
  constructor(readonly payload: MetricRecordedPayload) {
    super()
  }
}
