import { BaseEvent } from '@adonisjs/core/events'
import type { BillingErrorCode } from '../../exceptions/billing_exception.js'

/**
 * Fires when a webhook event has exhausted all retries in the queue.
 * Hooks to ops/paging integrations (PagerDuty, Slack, Sentry).
 *
 * The payload intentionally avoids `error.message` from raw exceptions.
 * Stripe SDK errors can carry request IDs, payment fragments, and other
 * fields that look like PII to compliance reviewers. `errorCode` is a
 * stable enum (`BillingErrorCode | 'unhandled_error'`); `details` is a
 * pre-sanitised free-form string only populated when the source error
 * was already a `BillingException` (whose message is package-controlled).
 */
export default class BillingEventDeadLettered extends BaseEvent {
  constructor(
    readonly payload: {
      eventId: string
      errorCode: BillingErrorCode | 'unhandled_error'
      details: string | null
    }
  ) {
    super()
  }
}
