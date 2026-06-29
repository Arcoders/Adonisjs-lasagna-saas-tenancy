import { BaseEvent } from '@adonisjs/core/events'

/**
 * Emitted when a tenant's subscription is paused by the provider, suspending
 * billing without canceling the subscription. The payload carries the tenant id
 * and the subscription id so listeners can revoke access until it resumes.
 */
export default class SubscriptionPaused extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      subscriptionId: string
    }
  ) {
    super()
  }
}
