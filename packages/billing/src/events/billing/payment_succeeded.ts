import { BaseEvent } from '@adonisjs/core/events'

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
