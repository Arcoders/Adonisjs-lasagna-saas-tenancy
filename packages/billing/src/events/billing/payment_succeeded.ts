import { BaseEvent } from '@adonisjs/core/events'

export default class PaymentSucceeded extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      invoiceId: string | null
      amount: number
      currency: string
    }
  ) {
    super()
  }
}
