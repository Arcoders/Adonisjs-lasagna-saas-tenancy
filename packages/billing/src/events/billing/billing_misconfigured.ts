import { BaseEvent } from '@adonisjs/core/events'

/**
 * Emitted when a Stripe webhook arrives carrying a product or price ID
 * that has no entry in `config.billing.products`. The package falls back
 * to `defaultPlan` and emits this event so ops can fix the mapping
 * without losing customer state.
 */
export default class BillingMisconfigured extends BaseEvent {
  constructor(
    readonly payload: {
      subscriptionId: string
      productId: string | null
      priceId: string | null
    }
  ) {
    super()
  }
}
