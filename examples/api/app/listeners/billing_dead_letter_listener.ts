import { BillingEventDeadLettered, BillingProcessedEvent } from '@adonisjs-lasagna/billing'
import logger from '@adonisjs/core/services/logger'
import type { EmitterService } from '@adonisjs/core/types'

/**
 * Demo: escalate dead-lettered billing webhooks to ops.
 *
 * The package fires `BillingEventDeadLettered` once a webhook event has either
 * exhausted the queue's retries or hit a known-fatal error. The package ships
 * the *signal*; the host decides where it goes. This listener is the seam where
 * you'd forward to PagerDuty / Slack / Sentry. The demo just logs at error
 * level, and pages "louder" for payment-related events (revenue at risk).
 *
 * The dead-letter payload is intentionally PII-safe (`eventId` + `errorCode` +
 * a package-controlled `details` string), so we re-read the ledger row to
 * enrich the alert with provider / event type / tenant for routing. The whole
 * handler is wrapped so alerting can never throw back into the emitter.
 */
export default class BillingDeadLetterListener {
  static register(emitter: EmitterService): void {
    emitter.on(BillingEventDeadLettered, async ({ payload }) => {
      try {
        const row = await BillingProcessedEvent.find(payload.eventId)
        const eventType = row?.eventType ?? 'unknown'
        const provider = row?.provider ?? 'unknown'
        // payment.* / invoice.* / transaction.* across the three providers.
        const revenueAtRisk = /payment|invoice|transaction/i.test(eventType)

        const alert = {
          severity: revenueAtRisk ? 'critical' : 'warning',
          eventId: payload.eventId,
          provider,
          eventType,
          tenantId: row?.tenantId ?? null,
          attempts: row?.attempts ?? null,
          errorCode: payload.errorCode,
          details: payload.details,
          replay: `node ace tenant:billing:replay --event-id=${payload.eventId}`,
        }

        // Host integration point: forward `alert` to PagerDuty / Slack / Sentry.
        logger.error(alert, `[billing] dead-lettered ${provider}/${eventType} — needs attention`)
      } catch {
        // Alerting is best-effort and must never throw back into the emitter.
      }
    })
  }
}
