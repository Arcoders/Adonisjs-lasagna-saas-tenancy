import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import BillingProcessedEvent from '../models/satellites/billing_processed_event.js'
import BillingService from '../services/billing_service.js'
import BillingException from '../exceptions/billing_exception.js'
import { dispatchBillingEvent } from '../services/billing/billing_event_dispatcher.js'
import { redactBillingEvent } from '../services/billing/redact.js'

interface ProcessBillingEventPayload {
  eventId: string
}

/**
 * A 'processing' claim older than this is treated as abandoned (its worker
 * crashed) and may be re-claimed. Comfortably longer than the per-attempt
 * timeout so a healthy in-flight job is never stolen from under itself.
 */
const STALE_CLAIM_MINUTES = 15

/**
 * Async handler for inbound billing webhooks (provider-agnostic).
 *
 * Why async: providers expect a fast 2xx ack. A handler doing DB writes + a
 * provider re-fetch can exceed that under contention; async also gives free
 * retries with backoff. The receive-time idempotency ledger makes retries safe.
 *
 * The job re-fetches the event via `BillingService.retrieveEvent` (the active
 * driver's tamper guard when supported; otherwise the signature-verified replay
 * payload) rather than trusting the queue, and keeps the queue payload to
 * `{ eventId }`.
 */
export default class ProcessBillingEventJob extends Job<ProcessBillingEventPayload> {
  static options = { name: 'lasagna.ProcessBillingEventJob' }

  async execute(): Promise<void> {
    const { eventId } = this.payload

    // ATOMIC CLAIM. A single guarded UPDATE flips a claimable ledger row
    // (pending/failed, or a 'processing' row abandoned by a crashed worker) to
    // 'processing' and bumps attempts. Only the worker whose UPDATE returns the
    // row proceeds, so two concurrent deliveries/retries of the same event can't
    // both reach dispatchBillingEvent and double-grant the host-facing
    // application event (e.g. PaymentSucceeded). The old read-then-check left a
    // TOCTOU window open here.
    const outcome = await this.#claim(eventId)
    if (outcome === 'missing') {
      logger.error(
        { event_id: eventId },
        'billing.event.no_ledger_row: refusing to process — event_id not in billing_processed_events'
      )
      return
    }
    if (outcome === 'completed') {
      logger.debug({ event_id: eventId }, 'billing.event.already_completed: skipping')
      return
    }
    if (outcome === 'in_flight') {
      logger.warn(
        { event_id: eventId },
        'billing.event.claim_lost: another worker holds the processing claim, skipping to avoid double-processing'
      )
      return
    }

    // We own the claim. Load the row we just transitioned for the rest of the flow.
    const row = await BillingProcessedEvent.findOrFail(eventId)

    let event
    try {
      const billing = await app.container.make(BillingService)
      event = await billing.retrieveEvent(eventId)
    } catch (err) {
      if (await this.#shortCircuitIfFatal(row, err, eventId)) return
      await this.#markFailed(row, err)
      throw err
    }

    const start = Date.now()
    try {
      const billing = await app.container.make(BillingService)
      const result = await dispatchBillingEvent(event, { billing, logger })
      row.status = 'completed'
      row.completedAt = DateTime.utc()
      row.lastError = null
      if (result.tenant_id) row.tenantId = result.tenant_id
      await row.save()

      logger.info(
        { ...redactBillingEvent(event), duration_ms: Date.now() - start, outcome: result.outcome },
        'billing.event.processed'
      )
    } catch (err) {
      if (await this.#shortCircuitIfFatal(row, err, eventId)) return
      await this.#markFailed(row, err)
      throw err
    }
  }

  async failed(error: Error): Promise<void> {
    // Final retry exhausted. Promote to `failed` for the doctor + replay, and
    // fire a dead-letter event. Never log raw error messages — wrap into our
    // own taxonomy first (provider errors can carry request ids / PII).
    const { eventId } = this.payload
    const { errorCode, details } = classifyError(error)

    logger.error(
      { event_id: eventId, error_code: errorCode },
      'billing.event.dead_lettered: all retries exhausted'
    )
    try {
      const row = await BillingProcessedEvent.find(eventId)
      if (row && row.status !== 'completed') {
        row.status = 'failed'
        row.lastError = (details ?? errorCode).slice(0, 500)
        await row.save()
      }
      const { default: BillingEventDeadLettered } =
        await import('../events/billing/billing_event_dead_lettered.js')
      await BillingEventDeadLettered.dispatch({ eventId, errorCode, details })
    } catch (innerErr) {
      logger.error(
        { event_id: eventId, err: (innerErr as Error)?.message },
        'billing.event.dead_letter_emit_failed'
      )
    }
  }

  /**
   * Atomically claim the ledger row for processing. Returns:
   *  - `'claimed'`: this worker won the row (status is now 'processing');
   *  - `'completed'`: already processed, skip;
   *  - `'in_flight'`: another (live) worker holds the claim, skip to avoid a
   *    double-dispatch;
   *  - `'missing'`: no ledger row exists for this event_id.
   *
   * The UPDATE both checks and transitions in one statement, so the decision is
   * race-free even under concurrent deliveries. A 'processing' row older than the
   * stale window is reclaimable (its worker crashed). `processed_at` doubles as
   * the claim heartbeat for that staleness check.
   */
  async #claim(eventId: string): Promise<'claimed' | 'completed' | 'in_flight' | 'missing'> {
    const schema = getConfig().backofficeSchemaName
    const claimed = await db.connection(getConfig().backofficeConnectionName).rawQuery(
      `UPDATE ??.billing_processed_events
          SET status = 'processing', attempts = attempts + 1, processed_at = now()
        WHERE event_id = ?
          AND (
            status IN ('pending', 'failed')
            OR (status = 'processing' AND processed_at < now() - make_interval(mins => ?))
          )
        RETURNING event_id`,
      [schema, eventId, STALE_CLAIM_MINUTES]
    )
    const claimedCount = Array.isArray(claimed?.rows) ? claimed.rows.length : 0
    if (claimedCount > 0) return 'claimed'

    // Nothing claimed: tell apart missing / already-done / held-by-a-live-worker.
    const row = await BillingProcessedEvent.find(eventId)
    if (!row) return 'missing'
    if (row.status === 'completed') return 'completed'
    return 'in_flight'
  }

  async #markFailed(row: BillingProcessedEvent, err: unknown): Promise<void> {
    const { errorCode, details } = classifyError(err)
    row.lastError = (details ?? errorCode).slice(0, 500)
    await row.save()
  }

  /**
   * If the error is a known-fatal `BillingException`, mark the row permanently
   * `failed`, fire the dead-letter event, and return true so the caller skips
   * the throw. Returns false for retryable errors (caller falls through to
   * #markFailed + throw, letting the queue retry).
   */
  async #shortCircuitIfFatal(
    row: BillingProcessedEvent,
    err: unknown,
    eventId: string
  ): Promise<boolean> {
    if (!(err instanceof BillingException) || err.isRetryable()) {
      return false
    }
    row.status = 'failed'
    row.lastError = err.message.slice(0, 500)
    await row.save()
    logger.error(
      { event_id: eventId, error_code: err.billingCode },
      'billing.event.fatal: marking failed without retry — error is non-transient'
    )
    try {
      const { default: BillingEventDeadLettered } =
        await import('../events/billing/billing_event_dead_lettered.js')
      await BillingEventDeadLettered.dispatch({
        eventId,
        errorCode: err.billingCode,
        details: err.message,
      })
    } catch (innerErr) {
      logger.error(
        { event_id: eventId, err: (innerErr as Error)?.message },
        'billing.event.dead_letter_emit_failed'
      )
    }
    return true
  }
}

function classifyError(err: unknown): {
  errorCode: BillingException['billingCode'] | 'unhandled_error'
  details: string | null
} {
  if (err instanceof BillingException) {
    return { errorCode: err.billingCode, details: err.message }
  }
  return { errorCode: 'unhandled_error', details: null }
}
