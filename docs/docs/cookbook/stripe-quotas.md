---
title: Stripe + quotas
description: Wire Stripe subscriptions to Lasagna's plan/quota system. Webhook → plan assignment → quota middleware. Atomic, idempotent.
---

# Stripe + quotas

Subscriptions in Stripe map to plans in Lasagna's
[quota satellite](/docs/satellites/quotas). The bridge is one
controller and a few lines of webhook handling.

## The flow

```
Stripe ──► your /webhooks/stripe ──► QuotaService.assignPlan(tenant, plan)
                                       └► writes tenant_plans, kicks the cache
HTTP request ──► QuotaMiddleware ──► reads plan + usage ──► allows or 402
```

## 1. Map Stripe products to Lasagna plans

```ts
// app/billing/plan_map.ts
export const PLAN_MAP: Record<string, string> = {
  prod_starter: 'starter',
  prod_pro:     'pro',
  prod_team:    'team',
}
```

## 2. Define the plans in Lasagna

```ts
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'

const quotas = await app.container.make(QuotaService)

await quotas.upsertPlan('starter', {
  apiRequests: { limit: 10_000, window: 'month' },
  storageBytes: { limit: 5 * 1024 ** 3, window: 'snapshot' },
  webhooks: { limit: 100, window: 'day-rolling' },
})

await quotas.upsertPlan('pro', {
  apiRequests: { limit: 100_000, window: 'month' },
  storageBytes: { limit: 50 * 1024 ** 3, window: 'snapshot' },
  webhooks: { limit: 1000, window: 'day-rolling' },
})
```

Run this from a seeder or an ace command; it's idempotent.

## 3. Stripe webhook handler

```ts
// app/controllers/stripe_webhook_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Stripe from 'stripe'
import { PLAN_MAP } from '#billing/plan_map'

export default class StripeWebhookController {
  async handle({ request, response }: HttpContext) {
    const stripe = new Stripe(env.get('STRIPE_SECRET_KEY'))
    const sig = request.header('stripe-signature')!
    const event = stripe.webhooks.constructEvent(
      request.raw(),
      sig,
      env.get('STRIPE_WEBHOOK_SECRET')
    )

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.#syncPlan(event.data.object)
        break
      case 'customer.subscription.deleted':
        await this.#syncPlan(event.data.object, 'starter') // downgrade
        break
    }

    return response.ok({ received: true })
  }

  async #syncPlan(sub: Stripe.Subscription, fallback?: string) {
    const tenant = await Tenant.findByOrFail('stripe_customer_id', sub.customer)
    const stripeProduct = sub.items.data[0]?.price.product as string
    const plan = PLAN_MAP[stripeProduct] ?? fallback ?? 'starter'

    const quotas = await app.container.make(QuotaService)
    await quotas.assignPlan(tenant.id, plan)
  }
}
```

## 4. Wire the route + middleware

```ts
// start/routes.ts
router
  .post('/webhooks/stripe', '#controllers/stripe_webhook')
  .as('stripe.webhook')
  .use([middleware.rawBody()]) // Stripe requires the unparsed body for signature verification
```

## 5. Apply the quota middleware

```ts
// start/routes.ts
router
  .post('/api/messages', '#controllers/messages.create')
  .middleware([{ quota: { key: 'apiRequests' } }])

router
  .post('/api/uploads', '#controllers/uploads.create')
  .middleware([{ quota: { key: 'storageBytes', units: 'request.input.fileSize' } }])
```

Over-quota requests respond with HTTP 402 and `x-quota-*` headers.

## Idempotency

Stripe retries webhooks. The `assignPlan` call is idempotent; same
plan + same tenant = no-op. If you need to record one-shot side
effects (welcome email on first upgrade, audit log row), gate them
on `event.id` and dedupe through Redis or a `processed_event_ids`
table.

## Counters survive plan changes

Reassigning a plan recomputes the limits but does **not** reset the
counters. A tenant upgrading from starter to pro mid-month sees
their used counter unchanged but the limit grows. This is what most
SaaS expect; if you want pro-rated resets, build them on top of
`QuotaService.reset(tenantId, key)`.

## Read next

- [Quotas satellite](/docs/satellites/quotas)
- [Webhooks satellite](/docs/satellites/webhooks); for *outbound*
  events back to your tenants.
