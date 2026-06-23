import logger from '@adonisjs/core/services/logger'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantSuspended } from '@adonisjs-lasagna/saas-tenancy/events'
import type PaymentFailed from '../events/billing/payment_failed.js'
import type SubscriptionCanceled from '../events/billing/subscription_canceled.js'

/**
 * Opt-in: suspend a tenant on a terminal billing failure. Wired by
 * `BillingProvider` only when `config.billing.suspendOnPaymentFailure` is true.
 *
 * Triggers:
 *   - `PaymentFailed` with `final: true` (dunning exhausted), or
 *   - `SubscriptionCanceled` with `reason: 'dunning_failed'`.
 *
 * `user_canceled` cancellations and non-final dunning retries are ignored. The
 * transition is idempotent (an already-suspended/deleted tenant is skipped) and
 * dispatches `TenantSuspended` so cache invalidation fires on the resolving pods.
 */
export default class SuspendOnPaymentFailureListener {
  async handlePaymentFailed(event: PaymentFailed): Promise<void> {
    if (!getConfig().billing?.suspendOnPaymentFailure) return
    if (!event.payload.final) return
    await this.#suspend(event.payload.tenantId, 'payment_failed')
  }

  async handleSubscriptionCanceled(event: SubscriptionCanceled): Promise<void> {
    if (!getConfig().billing?.suspendOnPaymentFailure) return
    if (event.payload.reason !== 'dunning_failed') return
    await this.#suspend(event.payload.tenantId, 'dunning_failed')
  }

  async #suspend(tenantId: string, reason: string): Promise<void> {
    try {
      const repo = await resolveTenantRepository()
      const tenant = await repo.findById(tenantId, true)
      if (!tenant) {
        logger.warn({ tenant_id: tenantId, reason }, 'suspend_on_payment_failure.tenant_not_found')
        return
      }
      if (tenant.isDeleted) {
        logger.warn({ tenant_id: tenantId, reason }, 'suspend_on_payment_failure.already_deleted')
        return
      }
      if (tenant.isSuspended) {
        logger.info({ tenant_id: tenantId, reason }, 'suspend_on_payment_failure.already_suspended')
        return
      }
      await tenant.suspend()
      await TenantSuspended.dispatch(tenant)
      logger.info({ tenant_id: tenantId, reason }, 'suspend_on_payment_failure.suspended')
    } catch (err) {
      logger.error(
        { tenant_id: tenantId, reason, err: (err as Error)?.message },
        'suspend_on_payment_failure.failed'
      )
    }
  }
}
