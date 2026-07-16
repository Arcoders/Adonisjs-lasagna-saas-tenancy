import { BaseEvent } from '@adonisjs/core/events'

/**
 * Emitted when a tenant's subscription plan changes, on the provider's
 * `customer.subscription.updated` event. The payload carries the tenant id, the
 * subscription id, and both the previous and new plan names, so listeners can
 * adjust entitlements on an upgrade or a downgrade.
 */
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
