import logger from '@adonisjs/core/services/logger'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import BillingCustomer from '../models/satellites/billing_customer.js'
import BillingSubscription from '../models/satellites/billing_subscription.js'
import { getActiveBillingDriver } from '../services/billing/active_billing_driver.js'
import BillingException from '../exceptions/billing_exception.js'

/**
 * Cleans up provider state when a tenant is hard-deleted. Behaviour driven by
 * `config.billing.onTenantDelete`:
 *
 *   - `'cancel'` (default): immediately cancels any active/past_due/trialing/
 *     paused subscriptions through the active driver. Local mapping removed.
 *   - `'detach'`: leaves the provider subscription alive; removes only the
 *     local mapping.
 *   - `'preserve'`: no provider call, no local cleanup.
 *
 * Wired via `HookRegistry.before('destroy')` in `BillingProvider.start()`.
 */
export default class TenantDestroyBillingListener {
  async handle(tenant: TenantModelContract): Promise<void> {
    const cfg = getConfig().billing
    if (!cfg) return
    const policy = cfg.onTenantDelete ?? 'cancel'
    if (policy === 'preserve') return

    const customer = await BillingCustomer.find(tenant.id)
    if (!customer) return

    if (policy === 'cancel') {
      await this.#cancelActive(tenant.id)
    }

    // For both `cancel` and `detach`, drop the local customer mapping so a
    // future tenant with the same id doesn't inherit billing state. We do NOT
    // delete `billing_subscriptions` rows — the audit value of keeping
    // cancelled rows beats the storage cost.
    try {
      await customer.delete()
    } catch (err) {
      logger.warn(
        { tenant_id: tenant.id, err: (err as Error)?.message },
        'billing.tenant_destroy.cleanup_failed'
      )
    }
  }

  async #cancelActive(tenantId: string): Promise<void> {
    const active = await BillingSubscription.query()
      .where('tenantId', tenantId)
      .whereIn('status', ['active', 'past_due', 'trialing', 'paused'])

    if (active.length === 0) return

    const driver = await getActiveBillingDriver()
    if (!driver.supports('subscription_cancel') || !driver.cancelSubscription) {
      logger.warn(
        { tenant_id: tenantId, provider: driver.name },
        'billing.tenant_destroy.cancel_unsupported: driver cannot cancel subscriptions — leaving them active'
      )
      return
    }

    for (const sub of active) {
      try {
        await driver.cancelSubscription(sub.providerSubscriptionId)
        sub.status = 'canceled'
        await sub.save()
      } catch (err) {
        const wrapped =
          err instanceof BillingException
            ? err
            : new BillingException('api_error', 'failed to cancel subscription on tenant delete', {
                cause: err,
              })
        logger.error(
          {
            tenant_id: tenantId,
            provider: driver.name,
            provider_subscription_id: sub.providerSubscriptionId,
            billing_code: wrapped.billingCode,
            err: wrapped.message,
          },
          'billing.tenant_destroy.cancel_failed'
        )
      }
    }
  }
}
