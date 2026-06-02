---
title: Stripe + quotas
description: Wire the billing satellite end-to-end — Stripe checkout → webhook → plan assignment → quota middleware. Atomic and idempotent.
---

# Stripe + quotas

A practical recipe for tying Stripe subscriptions to the
[quotas satellite](/docs/satellites/quotas). When a tenant upgrades
in Stripe, their plan limits move with them automatically.

This is the *journey*. For the full reference (every config field,
every event, every command, the storage shape, error codes, testing
helpers), see the [Billing satellite](/docs/satellites/billing).

## Quickstart

### 1. Configure with billing enabled

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=billing
npm install stripe@^18
```

The configure step publishes 5 backoffice migrations
(`tenant_plans`, `stripe_customers`, `stripe_subscriptions`,
`stripe_processed_events`, `stripe_meter_events`), an
`app/mailers/quota_warning_mailer.ts` + view, and prints the snippets
to paste into `config/multitenancy.ts` and `start/routes.ts`.

```bash
node ace migration:run --connection=backoffice
```

### 2. Set environment variables

```bash
STRIPE_API_KEY=sk_test_...            # live key in production
STRIPE_WEBHOOK_SECRET=whsec_...       # from the Stripe dashboard
STRIPE_API_VERSION=2025-08-27.basil   # optional pin (recommended)
```

The package refuses to boot if `NODE_ENV=production` is paired with
a `sk_test_*` key (or vice versa), and also if
`STRIPE_WEBHOOK_SECRET` is empty or doesn't start with `whsec_`.
Set `STRIPE_ALLOW_LIVE_IN_DEV=true` to opt in to live keys outside
production for staging environments that legitimately need them.
See the [billing reference](../satellites/billing.md#environment-variables)
for the full env-var table and boot-guard semantics.

### 3. Add the config

```ts
// config/multitenancy.ts
import { defineConfig } from '@adonisjs-lasagna/saas-tenancy'
import env from '#start/env'

export default defineConfig({
  // …existing fields…

  ignorePaths: ['/admin', '/api/webhooks', '/health', '/webhooks/stripe'],

  plans: {
    defaultPlan: 'starter',
    definitions: {
      starter: { limits: { apiRequests: 10_000, storageBytes: 5 * 1024 ** 3 } },
      pro: { limits: { apiRequests: 100_000, storageBytes: 50 * 1024 ** 3 } },
    },
    // omit `getPlan` to use the storage-backed default — the package reads
    // `tenant_plans` (populated by the webhook) and caches 60 s.
    storage: 'auto',
  },

  billing: {
    driver: 'stripe',
    stripe: {
      apiKey: env.get('STRIPE_API_KEY'),
      webhookSecret: env.get('STRIPE_WEBHOOK_SECRET'),
    },
    products: {
      prod_starter: 'starter',
      prod_pro: 'pro',
    },
    defaultPlan: 'starter',
    notifyOnQuotaExceeded: true,
  },
})
```

### 4. Mount the webhook route

```ts
// start/routes.ts
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'

multitenancyBillingRoutes()
```

That registers `POST /webhooks/stripe`, gated by signature
verification.

### 5. Wire checkout and the billing portal (optional)

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
      successUrl: 'https://app.example.com/dashboard?checkout=ok',
      cancelUrl: 'https://app.example.com/pricing',
    })
    return response.redirect(url)
  }

  async portal({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const billing = await app.container.make(BillingService)
    const { url } = await billing.createBillingPortalSession(tenant, {
      returnUrl: 'https://app.example.com/settings',
    })
    return response.redirect(url)
  }
}
```

Apply your own auth + role checks on these routes —
`auth + activeTenant + role(owner|admin)` is the recommended stack.

## How plan assignment works

`QuotaService.assignPlan(tenantId, planName)` upserts a row in
`tenant_plans` and busts the `(tenant, plan)` cache key on every
node via the BentoCache redis bus.

`ProcessStripeEventJob` calls `assignPlan` automatically on every
`customer.subscription.{created,updated,deleted}`. Plan
**definitions** (the limit values) live in `config.plans.definitions`;
only the **assignment** (tenant → plan name) lives in the database.
A misconfigured Stripe product that doesn't map to a declared plan
falls back to `defaultPlan` and emits a `BillingMisconfigured` event,
so it surfaces in the event log without losing customer state.

Counter behaviour on plan change:

- Re-assigning to the same plan is a no-op (no cache bust, no quota
  reset).
- Upgrades surface a higher limit on the next `getLimit` call
  (≤ 60 s).
- Downgrades take effect immediately. Counters are NOT reset — a
  user mid-period over their new limit gets 402s until the rolling
  counter rolls. Configure `dunning.gracePeriodDays` to delay
  enforcement.

For the full state machine (dunning, ordering guards,
`INSERT ... ON CONFLICT DO NOTHING` idempotency) see the
[Billing satellite](/docs/satellites/billing#webhook-receiver).

## Local development

```bash
# Forward Stripe webhooks to your local app
stripe listen --forward-to localhost:3333/webhooks/stripe

# Trigger an event without leaving the terminal
stripe trigger customer.subscription.created
```

For CI without `stripe listen` running, the package ships a
synthetic-event helper:

```bash
node ace tenant:billing:test-webhook customer.subscription.created
```

…which builds and signs a synthetic event and POSTs it to the local
endpoint. Replace customer/product IDs in the template (or pass
`--object=path/to/body.json`) for an end-to-end run.

For unit tests, use the in-memory SDK double — see
[Billing satellite#testing](/docs/satellites/billing#testing).

## Read next

- [Billing satellite](/docs/satellites/billing) — full reference:
  config table, all 10 events, all 6 ace commands, dunning, metered
  billing, lifecycle policies, error codes.
- [Quotas satellite](/docs/satellites/quotas) — the limit-enforcement
  side of the integration.
- [Webhooks satellite](/docs/satellites/webhooks) — outbound webhooks
  to your tenants (separate from this inbound Stripe receiver).
