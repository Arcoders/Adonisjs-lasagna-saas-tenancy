import { BaseEvent } from '@adonisjs/core/events'

/** Emitted on `customer.subscription.updated` whenever the plan changes. */
export default class SubscriptionUpdated extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      subscriptionId: string
      previousPlan: string | null
      newPlan: string
    }
  ) {
    super()
  }
}
