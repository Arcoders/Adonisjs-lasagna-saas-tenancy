import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { BillingService, BillingCustomer } from '@adonisjs-lasagna/billing'
import { currentTenant } from '#app/helpers/current_tenant'

/**
 * The company's SaaS subscription surface (the company paying Karimoto, NOT the
 * renter paying the company). The client sends a PLAN name; the server resolves
 * it to a price id from this allowlist, so a caller can never pass a raw price.
 * Offline in dev via the injected MockStripe; a real Stripe key makes checkout
 * return a live URL with no code change.
 */
const PRICE_BY_PLAN: Record<string, string> = {
  starter: 'price_starter_monthly',
  fleet: 'price_fleet_monthly',
  enterprise: 'price_enterprise_monthly',
}

@inject()
export default class BillingController {
  constructor(private readonly billing: BillingService) {}

  async show({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const customer = await BillingCustomer.find(tenant.id)
    return response.ok({
      plan: tenant.metadata.plan,
      hasCustomer: customer !== null,
      providerCustomerId: customer?.providerCustomerId ?? null,
    })
  }

  async checkout({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const plan = String(request.input('plan') ?? '')
    const priceId = PRICE_BY_PLAN[plan]
    if (!priceId) {
      return response.badRequest({
        error: { code: 'unknown_plan', message: `Unknown plan "${plan}".` },
      })
    }
    const session = await this.billing.createCheckoutSession(tenant, {
      priceId,
      successUrl: `http://${tenant.customDomain ?? 'localhost'}:3333/subscription?checkout=success`,
      cancelUrl: `http://${tenant.customDomain ?? 'localhost'}:3333/subscription?checkout=cancel`,
    })
    return response.ok({ url: session.url, id: session.id })
  }

  async portal({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const session = await this.billing.createBillingPortalSession(tenant, {
      returnUrl: `http://${tenant.customDomain ?? 'localhost'}:3333/subscription`,
    })
    return response.ok({ url: session.url })
  }
}
