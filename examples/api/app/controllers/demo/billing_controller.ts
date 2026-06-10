import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { BillingService, StripeCustomer } from '@adonisjs-lasagna/billing'
import type { DemoMeta } from '#app/models/backoffice/tenant'

/**
 * Demonstrates the billing satellite added on top of the other satellites.
 *   - GET  /demo/billing           → does this tenant have a Stripe customer?
 *   - POST /demo/billing/checkout  → create a Checkout session for a plan
 *
 * BillingService is resolved from the container (it is a singleton holding the
 * Stripe client), so the e2e suite can inject MockStripe before the request and
 * the controller uses that same instance, no real Stripe account required.
 *
 * Trust boundary: the client picks a *plan name* from a server-side catalog,
 * never a raw Stripe price id. The resolved price is declared in
 * `config.billing.products`, so the checkout passes the price allowlist without
 * `allowUnknownPrices`. Forwarding a client-supplied price id with the allowlist
 * bypassed would let a caller check out at an arbitrary price.
 */

// Server-side catalog: plan name → Stripe price id. In a real app this lives in
// your database or config, never in the request body.
const PRICE_BY_PLAN: Record<string, string> = {
  pro: 'price_pro_monthly',
}

export default class BillingController {
  async show({ request, response }: HttpContext) {
    const tenant = await request.tenant<DemoMeta>()
    const customer = await StripeCustomer.find(tenant.id)
    return response.ok({
      tenantId: tenant.id,
      hasCustomer: customer !== null,
      stripeCustomerId: customer?.stripeCustomerId ?? null,
    })
  }

  async checkout({ request, response }: HttpContext) {
    const tenant = await request.tenant<DemoMeta>()
    const plan = (request.input('plan') as string) ?? 'pro'
    const priceId = PRICE_BY_PLAN[plan]
    if (!priceId) {
      return response.badRequest({ error: `unknown plan "${plan}"` })
    }

    const billing = await app.container.make(BillingService)
    const session = await billing.createCheckoutSession(tenant, {
      priceId,
      successUrl: 'https://app.example.test/billing/ok',
      cancelUrl: 'https://app.example.test/billing/cancel',
    })

    return response.ok({ tenantId: tenant.id, plan, checkoutId: session.id, url: session.url })
  }
}
