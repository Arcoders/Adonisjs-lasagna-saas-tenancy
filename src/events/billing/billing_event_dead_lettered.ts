import { BaseEvent } from '@adonisjs/core/events'

/**
 * Fires when a webhook event has exhausted all retries in the queue.
 * Hooks to ops/paging integrations (PagerDuty, Slack, Sentry).
 */
export default class BillingEventDeadLettered extends BaseEvent {
  constructor(
    readonly payload: {
      eventId: string
      error: string
    }
  ) {
    super()
  }
}
