import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { HttpContext } from '@adonisjs/core/http'
import BillingException from '../exceptions/billing_exception.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { toReplayablePayload } from '../services/billing/redact.js'
import ProcessBillingEventJob from '../jobs/process_billing_event_job.js'
import BillingProcessedEvent from '../models/satellites/billing_processed_event.js'
import type { BillingWebhookEvent } from '../contracts/types.js'

/**
 * Webhook receiver for billing events (provider-agnostic).
 *
 * Hot path:
 *   1. INSERT into `billing_processed_events` with ON CONFLICT DO NOTHING.
 *   2. Dispatch async to the queue: providers expect a fast 2xx, and handlers
 *      can take 100s of ms (DB writes + a provider re-fetch).
 *
 * Failure modes handled: duplicate delivery (ON CONFLICT no-op, but re-dispatch
 * the narrow case where the original dispatch never reached a worker), and a
 * queue outage (re-throw 5xx so the provider retries the whole delivery).
 *
 * NOT a public surface. Mounted internally by `multitenancyBillingRoutes()`.
 */
export default class BillingWebhookController {
  async handle({ request, response }: HttpContext) {
    const event = (request as { billingEvent?: BillingWebhookEvent }).billingEvent
    if (!event) {
      throw new BillingException(
        'invalid_signature',
        'webhook controller invoked without verified event (middleware bypassed?)'
      )
    }

    const schema = getConfig().backofficeSchemaName
    // Persist a PII-stripped, replayable copy of the neutral event so
    // `BillingService.retrieveEvent()` can replay it (aged-out events, or
    // providers without event retrieval).
    const replayablePayload = toReplayablePayload(event)
    const inserted = await db.connection(getConfig().backofficeConnectionName).rawQuery(
      `INSERT INTO ??.billing_processed_events
           (event_id, provider, event_type, processed_at, status, attempts, payload)
         VALUES (?, ?, ?, now(), 'pending', 0, ?)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
      [schema, event.id, event.provider, event.nativeType, JSON.stringify(replayablePayload)]
    )

    const rowCount = Array.isArray(inserted?.rows) ? inserted.rows.length : 0
    const isDuplicate = rowCount === 0

    let shouldDispatch = !isDuplicate
    if (isDuplicate) {
      const existing = await BillingProcessedEvent.find(event.id)
      if (existing && existing.status === 'pending' && (existing.attempts ?? 0) === 0) {
        // Prior delivery wrote the ledger row but dispatch failed (queue
        // outage). No worker has touched it (attempts=0), so re-dispatching is
        // safe. The worker is idempotent on `status='completed'` rows.
        shouldDispatch = true
        logger.warn(
          { event_id: event.id, event_type: event.type, provider: event.provider },
          'billing.webhook.redispatch: pending ledger row had no worker — retrying dispatch'
        )
      } else {
        logger.debug(
          {
            event_id: event.id,
            event_type: event.type,
            provider: event.provider,
            status: existing?.status ?? 'unknown',
          },
          'billing.webhook.duplicate'
        )
      }
    }

    if (shouldDispatch) {
      try {
        await app.container.make(ProcessBillingEventJob)
        await ProcessBillingEventJob.dispatch({ eventId: event.id })
      } catch (err) {
        logger.error(
          { event_id: event.id, err: (err as Error)?.message },
          'billing.webhook.dispatch_failed: queue refused dispatch — returning 5xx so the provider retries'
        )
        throw new BillingException(
          'queue_unavailable',
          'failed to enqueue billing event for processing',
          { status: 503, cause: err }
        )
      }
    }

    return response.ok({ received: true })
  }
}
