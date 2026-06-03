import { BaseEvent } from '@adonisjs/core/events'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Emitted by `QuotaService.track` and `QuotaService.consume` (only on the
 * allowed branch) when `config.plans.emitTracked === true`. Disabled by
 * default to keep the hot path overhead-free.
 *
 * Powers the metered-billing auto-bridge: `BillingService` listens, filters
 * by `config.billing.usageMapping`, and batch-reports to Stripe meters.
 * Hosts can also subscribe directly for analytics or custom integrations.
 */
export default class QuotaTracked extends BaseEvent {
  constructor(
    readonly tenant: TenantModelContract,
    readonly quota: string,
    readonly amount: number,
    readonly newTotal: number
  ) {
    super()
  }
}
