import { BaseEvent } from '@adonisjs/core/events'

/**
 * Emitted when a previously paused tenant subscription resumes and billing
 * restarts. The payload carries the tenant id and the subscription id so listeners
 * can restore the access that was suspended while the subscription was paused.
 */
export default class SubscriptionResumed extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      subscriptionId: string
    }
  ) {
    super()
  }
}
