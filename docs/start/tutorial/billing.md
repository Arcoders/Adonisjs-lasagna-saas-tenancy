---
title: 'Tutorial 4: Billing'
description: Put Helpdesk tenants on Stripe plans — define starter and pro, send a tenant to hosted checkout, let the webhook assign the plan, and enforce a per-plan ticket quota.
---

# Step 4: Billing

Time to charge for Helpdesk. You'll define two plans, send a tenant to Stripe's hosted
checkout, let an idempotent webhook assign the plan when payment succeeds, and turn that
plan into a real limit: a daily ticket quota that returns `429` once a tenant runs out.

Billing is inbound integration. The payment provider is the source of truth for charges;
Lasagna keeps a mirror to drive **plan assignment**, then the
[quotas satellite](/guides/satellites/quotas) enforces the plan's limits. The provider is
pluggable (Stripe, Paddle, Lemon Squeezy); this tutorial uses Stripe, the default.

## 1. Install billing

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=billing
npm install stripe@^22
node ace migration:run --connection=backoffice
```

Billing declares `requires: ['quotas']`, so the `tenant_plans` table you published in
[step 1](/start/tutorial/setup) is exactly what it builds on. The migrations add the
billing tables (`billing_customers`, `billing_subscriptions`, and the webhook bookkeeping)
to the backoffice schema.

Set the Stripe credentials. The package refuses to boot on a `sk_test_*` key under
`NODE_ENV=production` (or a live key outside it), so a stray prod `.env` can't quietly move
real money:

```bash
STRIPE_API_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

## 2. Define plans and map products

Two config blocks work together. `plans.definitions` declares the limits; `billing` maps
your Stripe product ids to those plan names. Helpdesk gates the number of tickets a tenant
can open per day:

```ts
// config/multitenancy.ts
plans: {
  defaultPlan: 'starter',
  definitions: {
    starter: { limits: { tickets: 100 } },
    pro:     { limits: { tickets: 10_000 } },
  },
},
billing: {
  driver: 'stripe',
  stripe: {
    apiKey: env.get('STRIPE_API_KEY'),
    webhookSecret: env.get('STRIPE_WEBHOOK_SECRET'),
  },
  products: { prod_starter: 'starter', prod_pro: 'pro' },
  defaultPlan: 'starter',
},
```

Every product in `products` and the `defaultPlan` must name a plan that exists in
`plans.definitions`; billing validates this at boot and refuses to start on a typo.

## 3. Mount the webhook receiver

```ts
// start/routes.ts
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'

multitenancyBillingRoutes()
```

This registers `POST /webhooks/billing`, gated by signature verification. The published
config already lists that path in `ignorePaths` so `TenantGuardMiddleware` doesn't try to
resolve a tenant from Stripe's request. When a verified `customer.subscription.*` event
arrives, billing calls `QuotaService.assignPlan` for you and the tenant's limits change
with no code on your side.

## 4. Send a tenant to checkout

`BillingService.createCheckoutSession` builds a hosted Stripe URL and auto-creates the
customer record. Wire it as your own route behind your auth and role middleware:

```ts
// app/controllers/billing_controller.ts
import { BillingService } from '@adonisjs-lasagna/billing'
import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'

export default class BillingController {
  async checkout({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const billing = await app.container.make(BillingService)
    const { url } = await billing.createCheckoutSession(tenant, {
      priceId: request.input('priceId'),
      successUrl: 'https://helpdesk.example.com/dashboard?checkout=ok',
      cancelUrl: 'https://helpdesk.example.com/pricing',
    })
    return response.redirect(url)
  }
}
```

When the tenant completes payment, Stripe fires the subscription webhook, billing assigns
the mapped plan, and the tenant is now on `pro` with its higher ticket ceiling. No polling,
no manual plan column to keep in sync.

## 5. Enforce the plan's quota

A plan is only as real as what it limits. Apply the `enforceQuota` middleware to the
create-ticket route from [step 2](/start/tutorial/tenants), keyed on the `tickets` limit you
defined above:

```ts
// start/routes.ts
import { enforceQuota } from '@adonisjs-lasagna/saas-tenancy/middleware'

router
  .post('/tickets', '#controllers/tickets_controller.store')
  .use(enforceQuota('tickets'))
```

On each request the middleware reads the tenant's active plan, atomically increments the
rolling-day counter, and throws `QuotaExceededException` (HTTP `429`) once the increment
would exceed the limit. A `starter` tenant is capped at 100 tickets a day; the same tenant
upgraded to `pro` immediately gets 10,000, because plan resolution happens per request.

<Callout type="tip" title="Local webhook testing">
You don't need a deployed URL to see plan assignment work. Run
<code>stripe listen --forward-to localhost:3333/webhooks/billing</code> and
<code>stripe trigger customer.subscription.created</code>, or use the bundled
<code>node ace tenant:billing:test-webhook</code> command. Details in
<a href="/guides/satellites/billing#local-development">Billing › Local development</a>.
</Callout>

## Read next

- [Step 5: Reporting](/start/tutorial/reporting); turn tenant activity into a usage dashboard.
- [Billing](/guides/satellites/billing); every config field, the dunning state machine, and metered billing.
- [Quotas](/guides/satellites/quotas); counter modes, the Redis degradation policy, and admin endpoints.
