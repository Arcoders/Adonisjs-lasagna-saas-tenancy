import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { BillingService, BillingCustomer } from '@adonisjs-lasagna/billing'
import type { DemoMeta } from '#app/models/backoffice/tenant'

/**
 * Demonstrates the billing satellite added on top of the other satellites.
 *   - GET  /demo/billing           → does this tenant have a billing customer?
 *   - POST /demo/billing/checkout  → create a Checkout session for a plan
 *
 * BillingService is injected from the container (a singleton that delegates to
 * the active billing driver), so the e2e suite can inject a mock SDK / driver
 * before the request and the controller uses that same instance, no real
 * provider account required.
 *
 * Trust boundary: the client picks a *plan name* from a server-side catalog,
 * never a raw provider price id. The resolved price is declared in
 * `config.billing.products`, so the checkout passes the price allowlist without
 * `allowUnknownPrices`. Forwarding a client-supplied price id with the allowlist
 * bypassed would let a caller check out at an arbitrary price.
 */

// Server-side catalog: plan name → provider price id. In a real app this lives
// in your database or config, never in the request body.
const PRICE_BY_PLAN: Record<string, string> = {
  pro: 'price_pro_monthly',
}

@inject()
export default class BillingController {
  constructor(private readonly billing: BillingService) {}

  async show({ request, response }: HttpContext) {
    const tenant = await request.tenant<DemoMeta>()
    const customer = await BillingCustomer.find(tenant.id)
    return response.ok({
      tenantId: tenant.id,
      hasCustomer: customer !== null,
      providerCustomerId: customer?.providerCustomerId ?? null,
    })
  }

  async checkout({ request, response }: HttpContext) {
    const tenant = await request.tenant<DemoMeta>()
    const plan = (request.input('plan') as string) ?? 'pro'
    const priceId = PRICE_BY_PLAN[plan]
    if (!priceId) {
      return response.badRequest({ error: `unknown plan "${plan}"` })
    }

    const session = await this.billing.createCheckoutSession(tenant, {
      priceId,
      successUrl: 'https://app.example.test/billing/ok',
      cancelUrl: 'https://app.example.test/billing/cancel',
    })

    return response.ok({ tenantId: tenant.id, plan, checkoutId: session.id, url: session.url })
  }
}
