import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import StripeCustomer from '../models/satellites/stripe_customer.js'
import StripeSubscription from '../models/satellites/stripe_subscription.js'
import BillingService from '../services/billing_service.js'
import BillingException from '../exceptions/billing_exception.js'

/**
 * Cleans up Stripe state when a tenant is hard-deleted. Behaviour driven
 * by `config.billing.onTenantDelete`:
 *
 *   - `'cancel'` (default): immediately cancels any active/past_due/trialing
 *     subscriptions in Stripe (no proration, no final invoice). Local rows
 *     are removed.
 *   - `'detach'`: leaves the Stripe subscription alive. Removes only the
 *     local mapping. Useful when the tenant is "deleted" from the app's
 *     perspective but billing should continue (rare; e.g. account merge).
 *   - `'preserve'`: no Stripe API call, no local cleanup. Operator handles
 *     it manually.
 *
 * Wired via `HookRegistry.beforeDestroy` in
 * `MultitenancyProvider.start()` when `config.billing` is set.
 */
export default class TenantDestroyBillingListener {
  async handle(tenant: TenantModelContract): Promise<void> {
    const cfg = getConfig().billing
    if (!cfg) return
    const policy = cfg.onTenantDelete ?? 'cancel'
    if (policy === 'preserve') return

    const customer = await StripeCustomer.find(tenant.id)
    if (!customer) return

    if (policy === 'cancel') {
      await this.#cancelActive(tenant.id, customer.stripeCustomerId)
    }

    // For both `cancel` and `detach`, drop the local customer mapping so a
    // future tenant with the same id doesn't inherit billing state. We do
    // NOT delete `stripe_subscriptions` rows — the audit value of keeping
    // cancelled rows beats the storage cost (and the FK ON DELETE RESTRICT
    // would block this delete anyway if any subs were still in 'active').
    try {
      await customer.delete()
    } catch (err) {
      logger.warn(
        { tenant_id: tenant.id, err: (err as Error)?.message },
        'billing.tenant_destroy.cleanup_failed'
      )
    }
  }

  async #cancelActive(tenantId: string, stripeCustomerId: string): Promise<void> {
    const active = await StripeSubscription.query()
      .where('tenantId', tenantId)
      .whereIn('status', ['active', 'past_due', 'trialing', 'paused'])

    if (active.length === 0) return

    const billing = await app.container.make(BillingService)
    const stripe = await billing.getClient()

    for (const sub of active) {
      try {
        await stripe.subscriptions.cancel(sub.stripeSubscriptionId, {
          invoice_now: false,
          prorate: false,
        })
        sub.status = 'canceled'
        await sub.save()
      } catch (err) {
        const wrapped =
          err instanceof BillingException
            ? err
            : BillingException.fromStripeError(
                err,
                'failed to cancel subscription on tenant delete'
              )
        logger.error(
          {
            tenant_id: tenantId,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: sub.stripeSubscriptionId,
            billing_code: wrapped.billingCode,
            err: wrapped.message,
          },
          'billing.tenant_destroy.cancel_failed'
        )
      }
    }
  }
}
