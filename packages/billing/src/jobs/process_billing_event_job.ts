import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import BillingProcessedEvent from '../models/satellites/billing_processed_event.js'
import BillingService from '../services/billing_service.js'
import BillingException from '../exceptions/billing_exception.js'
import { dispatchBillingEvent } from '../services/billing/billing_event_dispatcher.js'
import { redactBillingEvent } from '../services/billing/redact.js'

interface ProcessBillingEventPayload {
  eventId: string
}

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
    const row = await BillingProcessedEvent.find(eventId)
    if (!row) {
      logger.error(
        { event_id: eventId },
        'billing.event.no_ledger_row: refusing to process — event_id not in billing_processed_events'
      )
      return
    }
    if (row.status === 'completed') {
      logger.debug({ event_id: eventId }, 'billing.event.already_completed: skipping')
      return
    }

    row.attempts = (row.attempts ?? 0) + 1
    await row.save()

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
