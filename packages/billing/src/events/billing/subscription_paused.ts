import { BaseEvent } from '@adonisjs/core/events'

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
