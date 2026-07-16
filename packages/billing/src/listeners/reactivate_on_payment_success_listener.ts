import logger from '@adonisjs/core/services/logger'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantActivated } from '@adonisjs-lasagna/saas-tenancy/events'
import type PaymentSucceeded from '../events/billing/payment_succeeded.js'

/**
 * Opt-in companion to {@link SuspendOnPaymentFailureListener}: reactivate a
 * suspended tenant once payment recovers. Wired by `BillingProvider` only when
 * BOTH `config.billing.suspendOnPaymentFailure` and
 * `config.billing.reactivateOnPaymentSuccess` are true.
 *
 * Idempotent: an already-active or deleted tenant is skipped. Dispatches
 * `TenantActivated` so cache invalidation fires.
 */
export default class ReactivateOnPaymentSuccessListener {
  async handle(event: PaymentSucceeded): Promise<void> {
    const cfg = getConfig().billing
    if (!cfg?.suspendOnPaymentFailure || !cfg?.reactivateOnPaymentSuccess) return

    try {
      const repo = await resolveTenantRepository()
      const tenant = await repo.findById(event.payload.tenantId, true)
      if (!tenant) {
        logger.warn(
          { tenant_id: event.payload.tenantId },
          'reactivate_on_payment_success.tenant_not_found'
        )
        return
      }
      if (tenant.isDeleted) {
        logger.warn(
          { tenant_id: event.payload.tenantId },
          'reactivate_on_payment_success.already_deleted'
        )
        return
      }
      if (tenant.isActive) {
        logger.info(
          { tenant_id: event.payload.tenantId },
          'reactivate_on_payment_success.already_active'
        )
        return
      }
      await tenant.activate()
      await TenantActivated.dispatch(tenant)
      logger.info({ tenant_id: event.payload.tenantId }, 'reactivate_on_payment_success.activated')
    } catch (err) {
      logger.error(
        { tenant_id: event.payload.tenantId, err: (err as Error)?.message },
        'reactivate_on_payment_success.failed'
      )
    }
  }
}
