import { BaseEvent } from '@adonisjs/core/events'

/**
 * Emitted when a tenant's subscription is canceled, on the provider's
 * `customer.subscription.deleted` event, whether a manual cancellation or the
 * final dunning step. The payload carries the tenant id, the subscription id, the
 * previous plan, and a reason distinguishing a user cancel from a dunning failure.
 */
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
