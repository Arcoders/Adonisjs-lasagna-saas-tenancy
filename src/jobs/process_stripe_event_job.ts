import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import StripeProcessedEvent from '../models/satellites/stripe_processed_event.js'
import BillingService from '../services/billing_service.js'
import BillingException from '../exceptions/billing_exception.js'
import { dispatchStripeEvent } from '../services/billing/stripe_event_dispatcher.js'
import { redactStripeEvent } from '../services/billing/redact.js'

interface ProcessStripeEventPayload {
  eventId: string
}

/**
 * Async handler for Stripe webhooks.
 *
 * Why async (not inline in the controller): Stripe expects a 200 ack
 * within 5s. A handler doing DB writes + a Stripe re-fetch can easily
 * exceed that under contention. Async also gives us free retries with
 * exponential backoff via the queue layer — the webhook ack is
 * idempotent (controller stamps `stripe_processed_events`), so a retry
 * loop on the job side never causes double-acks back to Stripe.
 *
 * The job re-fetches the event from Stripe (`stripe.events.retrieve`)
 * rather than trusting the queue payload. Two reasons:
 *   - tampering — a compromised queue entry can't slip a forged event past
 *     the signature check (we already validated at webhook receive time,
 *     but re-fetching is cheap insurance).
 *   - size — keeping the queue payload to `{ eventId }` lets us hold a
 *     deeper retry buffer per worker.
 */
export default class ProcessStripeEventJob extends Job<ProcessStripeEventPayload> {
  static options = { name: 'lasagna.ProcessStripeEventJob' }

  async execute(): Promise<void> {
    const { eventId } = this.payload
    const row = await StripeProcessedEvent.find(eventId)
    if (!row) {
      // The controller writes the row before dispatch — missing means
      // someone hand-dispatched without a controller pass. Refuse, log.
      logger.error(
        { event_id: eventId },
        'stripe.event.no_ledger_row: refusing to process — event_id not in stripe_processed_events'
      )
      return
    }
    if (row.status === 'completed') {
      logger.debug({ event_id: eventId }, 'stripe.event.already_completed: skipping')
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
      const result = await dispatchStripeEvent(event, { billing, logger })
      row.status = 'completed'
      row.completedAt = DateTime.utc()
      row.lastError = null
      if (result.tenant_id) row.tenantId = result.tenant_id
      await row.save()

      logger.info(
        {
          ...redactStripeEvent(event),
          duration_ms: Date.now() - start,
          outcome: result.outcome,
        },
        'stripe.event.processed'
      )
    } catch (err) {
      if (await this.#shortCircuitIfFatal(row, err, eventId)) return
      await this.#markFailed(row, err)
      throw err
    }
  }

  async failed(error: Error): Promise<void> {
    // Final retry exhausted. Promote the row to `failed` so the doctor
    // surfaces it and the operator can `tenant:billing:replay` after a
    // fix. Also fire a dead-letter event for paging integrations.
    //
    // We DO NOT log `error.message` directly: a raw StripeError can carry
    // request IDs, payment fragments, or unredacted payload bits. Wrap
    // first into our own taxonomy.
    const { eventId } = this.payload
    const { errorCode, details } = classifyError(error)

    logger.error(
      { event_id: eventId, error_code: errorCode },
      'stripe.event.dead_lettered: all retries exhausted'
    )
    try {
      const row = await StripeProcessedEvent.find(eventId)
      if (row && row.status !== 'completed') {
        row.status = 'failed'
        row.lastError = (details ?? errorCode).slice(0, 500)
        await row.save()
      }
      const { default: BillingEventDeadLettered } = await import(
        '../events/billing/billing_event_dead_lettered.js'
      )
      await BillingEventDeadLettered.dispatch({ eventId, errorCode, details })
    } catch (innerErr) {
      logger.error(
        { event_id: eventId, err: (innerErr as Error)?.message },
        'stripe.event.dead_letter_emit_failed'
      )
    }
  }

  async #markFailed(row: StripeProcessedEvent, err: unknown): Promise<void> {
    // BillingException messages are package-controlled (we wrote them) and
    // safe to persist. Anything else collapses to a stable code so an
    // unredacted Stripe error message never lands in `last_error`.
    const { errorCode, details } = classifyError(err)
    row.lastError = (details ?? errorCode).slice(0, 500)
    await row.save()
  }

  /**
   * If the error is a known-fatal `BillingException`, mark the row as
   * permanently `failed`, fire the dead-letter event, and return true
   * so the caller skips the throw. Returns false for retryable errors
   * (caller should fall through to #markFailed + throw, letting BullMQ
   * retry).
   *
   * Retryable: network, rate-limit, 5xx, queue, customer/tenant resolution
   * race. Fatal: bad config, revoked auth, deleted Stripe resource,
   * card declined, signature mismatch.
   *
   * Without this short-circuit a misconfigured product mapping or a
   * revoked API key burns through the BullMQ retry budget (default 3
   * attempts with exponential backoff = ~30s of latency) before
   * surfacing in the dead-letter queue. Fail fast instead.
   */
  async #shortCircuitIfFatal(
    row: StripeProcessedEvent,
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
      'stripe.event.fatal: marking failed without retry — error is non-transient'
    )
    try {
      const { default: BillingEventDeadLettered } = await import(
        '../events/billing/billing_event_dead_lettered.js'
      )
      await BillingEventDeadLettered.dispatch({
        eventId,
        errorCode: err.billingCode,
        details: err.message,
      })
    } catch (innerErr) {
      logger.error(
        { event_id: eventId, err: (innerErr as Error)?.message },
        'stripe.event.dead_letter_emit_failed'
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
