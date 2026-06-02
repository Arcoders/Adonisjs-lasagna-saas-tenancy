import { BaseEvent } from '@adonisjs/core/events'

export default class SubscriptionResumed extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      stripeSubscriptionId: string
    }
  ) {
    super()
  }
}
