import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import type { HttpContext } from '@adonisjs/core/http'
import type Stripe from 'stripe'
import StripeProcessedEvent from '../models/satellites/stripe_processed_event.js'
import BillingException from '../exceptions/billing_exception.js'
import { redactStripeEvent } from '../services/billing/redact.js'
import ProcessStripeEventJob from '../jobs/process_stripe_event_job.js'

/**
 * Webhook receiver for Stripe events.
 *
 * Hot path:
 *   1. Insert into `stripe_processed_events` with ON CONFLICT DO NOTHING.
 *      Conflict (rowCount === 0) means we've seen this event_id already
 *      — ack 200 instantly without running any handler.
 *   2. Dispatch async to BullMQ — Stripe expects a 200 within 5s, and
 *      handlers can take 100s of ms (DB writes, Stripe API re-fetch).
 *      Letting the job retry on transient failures is far safer than
 *      timing out the webhook and triggering Stripe's exponential retry
 *      from scratch.
 *
 * NOT exported as a public surface. Mounted internally by
 * `multitenancyBillingRoutes()` so hosts don't need to wire the route
 * themselves.
 */
export default class StripeWebhookController {
  async handle({ request, response }: HttpContext) {
    const event = (request as { stripeEvent?: Stripe.Event }).stripeEvent
    if (!event) {
      // Middleware should have failed before us — defensive guard.
      throw new BillingException(
        'invalid_signature',
        'webhook controller invoked without verified event (middleware bypassed?)'
      )
    }

    // Insert + race-safe dedupe. Reading `existing` after a race-loss
    // returns the duplicate's row, which lets us reply 200 deterministically.
    let isDuplicate = false
    try {
      const row = new StripeProcessedEvent()
      row.eventId = event.id
      row.eventType = event.type
      row.status = 'pending'
      row.attempts = 0
      // Persist the redacted payload as a fallback for events older than
      // Stripe's 30-day retrieval window. We DO NOT store the full event
      // body (it can contain PII via metadata).
      row.payload = redactStripeEvent(event) as unknown as Record<string, unknown>
      await row.save()
    } catch (err) {
      // PK collision = duplicate event_id. That's the success path under
      // Stripe retry — log it once and proceed to ack.
      const existing = await StripeProcessedEvent.find(event.id)
      if (existing) {
        isDuplicate = true
        logger.debug(
          { event_id: event.id, event_type: event.type, status: existing.status },
          'stripe.webhook.duplicate'
        )
      } else {
        // A non-PK error — surface it.
        throw err
      }
    }

    if (!isDuplicate) {
      // Fire-and-forget — the job re-fetches the event from Stripe and
      // owns retry/dunning. We don't await dispatch failure cause the
      // webhook MUST return < 5s; a queue outage shouldn't replay every
      // future event from Stripe's retry tier.
      try {
        await app.container.make(ProcessStripeEventJob)
        await ProcessStripeEventJob.dispatch({ eventId: event.id })
      } catch (err) {
        logger.error(
          { event_id: event.id, err: (err as Error)?.message },
          'stripe.webhook.dispatch_failed: queue refused dispatch — event will need manual replay'
        )
      }
    }

    return response.ok({ received: true })
  }
}
