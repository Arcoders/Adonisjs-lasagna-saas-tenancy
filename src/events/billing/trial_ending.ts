import { BaseEvent } from '@adonisjs/core/events'

/**
 * Emitted on `customer.subscription.trial_will_end` (~3 days before trial
 * end by default). Hosts subscribe to send a reminder email or
 * onboarding nudge.
 */
export default class TrialEnding extends BaseEvent {
  constructor(
    readonly payload: {
      tenantId: string
      stripeSubscriptionId: string
      daysLeft: number
    }
  ) {
    super()
  }
}
