import { BaseEvent } from '@adonisjs/core/events'

/**
 * Emitted on every `invoice.payment_failed`. The `final` flag distinguishes
 * dunning-step warnings from the terminal "we've given up" event. Most
 * mailer / downgrade integrations should hook on `final: true` to avoid
 * spamming a user during the retry window.
 */
export default class PaymentFailed extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      invoiceId: string | null
      amount: number
      currency: string
      attempts: number
      final: boolean
      nextRetry: string | null
    }
  ) {
    super()
  }
}
