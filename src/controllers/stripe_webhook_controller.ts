import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { HttpContext } from '@adonisjs/core/http'
import type Stripe from 'stripe'
import BillingException from '../exceptions/billing_exception.js'
import { getConfig } from '../config.js'
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

    // Race-safe dedupe in a single round-trip: `INSERT ... ON CONFLICT
    // (event_id) DO NOTHING` returns the inserted row only when this
    // worker won the race. Two webhook deliveries with the same event_id
    // arriving simultaneously: one inserts, one no-ops. The losing call
    // sees rowCount === 0 and acks 200 without dispatching the job.
    //
    // Why not Lucid's `.save()` with try/catch on PK violation: the
    // try/catch can hide non-PK errors (constraint check, deadlock) by
    // misclassifying them as duplicates if a row coincidentally exists.
    // The raw INSERT is unambiguous and one less round-trip.
    const schema = getConfig().backofficeSchemaName
    const redactedPayload = redactStripeEvent(event) as unknown as Record<string, unknown>
    const inserted = await db
      .connection(getConfig().backofficeConnectionName)
      .rawQuery(
        `INSERT INTO ??.stripe_processed_events
           (event_id, event_type, processed_at, status, attempts, payload)
         VALUES (?, ?, now(), 'pending', 0, ?)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [schema, event.id, event.type, JSON.stringify(redactedPayload)]
      )

    // pg returns { rows: [...] }; the count of returned rows tells us
    // whether the INSERT actually happened.
    const rowCount = Array.isArray(inserted?.rows) ? inserted.rows.length : 0
    const isDuplicate = rowCount === 0

    if (isDuplicate) {
      logger.debug(
        { event_id: event.id, event_type: event.type },
        'stripe.webhook.duplicate'
      )
    } else {
      // Dispatch async — Stripe expects 200 within 5s, and the job owns
      // retry/dunning. We log dispatch failures (queue outage) but don't
      // fail the webhook — Stripe would retry the whole delivery and
      // re-trigger ON CONFLICT next round. Manual `tenant:billing:replay`
      // covers the rare case where the queue is down for hours.
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
