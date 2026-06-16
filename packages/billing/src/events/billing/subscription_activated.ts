import { BaseEvent } from '@adonisjs/core/events'

/** Emitted on `customer.subscription.created` (or first `.updated` flipping to active). */
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
