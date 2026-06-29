import { BaseEvent } from '@adonisjs/core/events'

/**
 * Emitted when a tenant's invoice is paid, after a successful charge. The payload
 * carries the tenant id, the invoice id, and the amount and currency charged, plus
 * an optional tax and total breakdown when the provider supplies one (Lasagna
 * never computes tax itself), for downstream revenue and tax reporting.
 */
export default class PaymentSucceeded extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      invoiceId: string | null
      amount: number
      currency: string
      /**
       * Tax / total the provider charged (integer minor units), when it breaks
       * them out. Present for revenue/tax reporting; `null` when the provider
       * doesn't supply a breakdown. We never compute tax.
       */
      tax?: number | null
      total?: number | null
    }
  ) {
    super()
  }
}
