import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { HttpContext } from '@adonisjs/core/http'
import type Stripe from 'stripe'
import BillingException from '../exceptions/billing_exception.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { toReplayablePayload } from '../services/billing/redact.js'
import ProcessStripeEventJob from '../jobs/process_stripe_event_job.js'
import StripeProcessedEvent from '../models/satellites/stripe_processed_event.js'

/**
 * Webhook receiver for Stripe events.
 *
 * Hot path:
 *   1. Insert into `stripe_processed_events` with ON CONFLICT DO NOTHING.
 *   2. Dispatch async to BullMQ — Stripe expects a 200 within 5s, and
 *      handlers can take 100s of ms (DB writes, Stripe API re-fetch).
 *
 * Failure modes the controller has to handle correctly:
 *   - Duplicate delivery from Stripe → ON CONFLICT collapses to a no-op
 *     UNLESS the original dispatch never reached a worker (ledger row
 *     present, `status='pending'`, `attempts=0`). In that case we
 *     re-dispatch — otherwise the event would be silently lost the
 *     moment Stripe's retry sees the existing pending row.
 *   - Queue outage → re-throw so we return 5xx and Stripe retries the
 *     whole delivery. ACKing 200 with a failed dispatch leaves the
 *     ledger row stuck `pending` with no recovery path short of manual
 *     `tenant:billing:replay`.
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
    // sees rowCount === 0 and falls through to the duplicate branch.
    //
    // Why not Lucid's `.save()` with try/catch on PK violation: the
    // try/catch can hide non-PK errors (constraint check, deadlock) by
    // misclassifying them as duplicates if a row coincidentally exists.
    // The raw INSERT is unambiguous and one less round-trip.
    const schema = getConfig().backofficeSchemaName
    // Persist a PII-stripped but structurally-faithful copy of the event so
    // `BillingService.retrieveEvent()` can replay it after it ages out of
    // Stripe's ~30-day retrieval window. It's allowlist-built (see redact.ts)
    // from named fields rather than the raw event, so no PII reaches the
    // backoffice DB.
    const replayablePayload = toReplayablePayload(event) as unknown as Record<string, unknown>
    const inserted = await db.connection(getConfig().backofficeConnectionName).rawQuery(
      `INSERT INTO ??.stripe_processed_events
           (event_id, event_type, processed_at, status, attempts, payload)
         VALUES (?, ?, now(), 'pending', 0, ?)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
      [schema, event.id, event.type, JSON.stringify(replayablePayload)]
    )

    // pg returns { rows: [...] }; the count of returned rows tells us
    // whether the INSERT actually happened.
    const rowCount = Array.isArray(inserted?.rows) ? inserted.rows.length : 0
    const isDuplicate = rowCount === 0

    let shouldDispatch = !isDuplicate
    if (isDuplicate) {
      // Conflict path. By default we treat duplicates as fully-ack'd,
      // but recover from the narrow case where the original dispatch
      // never reached a worker.
      const existing = await StripeProcessedEvent.find(event.id)
      if (existing && existing.status === 'pending' && (existing.attempts ?? 0) === 0) {
        // Prior delivery wrote the ledger row but the dispatch failed
        // (queue outage). A worker hasn't touched the row yet
        // (attempts=0), so re-dispatching is safe — the worker is
        // idempotent on `status='completed'` rows and would otherwise
        // never pick this up.
        shouldDispatch = true
        logger.warn(
          { event_id: event.id, event_type: event.type },
          'stripe.webhook.redispatch: pending ledger row had no worker — retrying dispatch'
        )
      } else {
        logger.debug(
          { event_id: event.id, event_type: event.type, status: existing?.status ?? 'unknown' },
          'stripe.webhook.duplicate'
        )
      }
    }

    if (shouldDispatch) {
      try {
        await app.container.make(ProcessStripeEventJob)
        await ProcessStripeEventJob.dispatch({ eventId: event.id })
      } catch (err) {
        // Re-throw so the response is 5xx and Stripe retries the
        // whole delivery. The ledger row stays as inserted; the next
        // delivery will hit the duplicate-pending-attempts=0 branch
        // above and re-dispatch when the queue is back.
        logger.error(
          { event_id: event.id, err: (err as Error)?.message },
          'stripe.webhook.dispatch_failed: queue refused dispatch — returning 5xx so Stripe retries'
        )
        throw new BillingException(
          'queue_unavailable',
          'failed to enqueue stripe event for processing',
          { status: 503, cause: err }
        )
      }
    }

    return response.ok({ received: true })
  }
}
