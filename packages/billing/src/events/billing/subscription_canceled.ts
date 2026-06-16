import { BaseEvent } from '@adonisjs/core/events'

/** Emitted on `customer.subscription.deleted` (manual cancel or final dunning step). */
export default class SubscriptionCanceled extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      subscriptionId: string
      previousPlan: string | null
      reason: 'user_canceled' | 'dunning_failed' | 'unknown'
    }
  ) {
    super()
  }
}
