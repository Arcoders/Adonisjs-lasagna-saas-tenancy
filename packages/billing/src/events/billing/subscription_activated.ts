import { BaseEvent } from '@adonisjs/core/events'

/**
 * Emitted when a tenant's subscription becomes active, on the provider's
 * `customer.subscription.created` event (or the first `.updated` that flips it to
 * active). The payload carries the tenant id, the provider subscription id, and
 * the activated plan name so listeners can grant the plan's entitlements.
 */
export default class SubscriptionActivated extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      subscriptionId: string
      planName: string
    }
  ) {
    super()
  }
}
