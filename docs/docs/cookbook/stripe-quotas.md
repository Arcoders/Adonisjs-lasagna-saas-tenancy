---
title: Stripe billing satellite
description: The packaged Stripe integration. Webhook + idempotency + checkout/portal helpers + dunning + metered billing — all wired by `--with=billing`.
---

# Stripe billing satellite

Lasagna ships a Stripe integration as the seventh satellite. Opt in at
configure time and the package wires the webhook, plan assignment, dunning,
and metered billing for you. Subscriptions in Stripe map to plans in the
[quotas satellite](/docs/satellites/quotas) — when a tenant upgrades, their
quota limits move with them automatically.

## Quickstart

### 1. Configure with billing enabled

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=billing
npm install stripe@^18
```

The configure step publishes:

- 5 backoffice migrations (`tenant_plans`, `stripe_customers`,
  `stripe_subscriptions`, `stripe_processed_events`, `stripe_meter_events`)
- `app/mailers/quota_warning_mailer.ts` + `resources/views/emails/quota_warning.edge`
- a printed snippet for `config/multitenancy.ts` and `start/routes.ts`

Run the migrations:

```bash
node ace migration:run --connection=backoffice
```

### 2. Set environment variables

```bash
STRIPE_API_KEY=sk_test_…              # test in dev, live in prod
STRIPE_WEBHOOK_SECRET=whsec_…         # from the Stripe dashboard
STRIPE_API_VERSION=2025-08-27.basil   # optional pin
```

The package refuses to boot if `NODE_ENV=production` is paired with a
`sk_test_*` key. Set `STRIPE_ALLOW_LIVE_IN_DEV=true` to silence the inverse
warning when a staging env legitimately uses live keys.

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
    // `tenant_plans` (populated by the webhook) and caches 60s.
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
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/saas-tenancy/health'

multitenancyBillingRoutes()
```

That registers `POST /webhooks/stripe`, gated by signature verification.

### 5. (Optional) Wire checkout and the billing portal

```ts
// app/controllers/billing_controller.ts
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
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

These endpoints are yours to wire — apply your own auth + role checks
(`auth + activeTenant + role(owner|admin)` is the recommended stack).

## How plan assignment works

`QuotaService.assignPlan(tenantId, planName)` upserts a row in
`tenant_plans` and busts the `(tenant, plan)` cache key on every node via
the BentoCache redis bus.

The webhook job calls `assignPlan` automatically on every
`customer.subscription.{created,updated,deleted}`. Plan **definitions**
(the limit values) live in `config.plans.definitions`; only the **assignment**
(tenant → plan name) lives in the database. A misconfigured Stripe product
that doesn't map to a declared plan falls back to `defaultPlan` and emits
a `BillingMisconfigured` event, so you'll see it in your event logs without
losing customer state.

Counter behaviour on plan change:

- Re-assigning to the same plan is a no-op (no cache bust, no quota reset).
- Upgrades surface a higher limit on the next `getLimit` call (≤60s).
- Downgrades take effect immediately. Counters are NOT reset — a user
  mid-period over their new limit will get 402s until the rolling counter
  rolls. Configure `gracePeriodDays` in `config.billing.dunning` to delay.

## Dunning

```ts
billing.dunning = {
  maxAttempts: 3,                     // matches Stripe Smart Retries
  action: 'none' | 'downgrade' | 'block',
  gracePeriodDays: 0,
}
```

- The job marks `stripe_subscriptions.status = 'past_due'` on the final
  failed-invoice attempt and emits `PaymentFailed { final: true }`.
- Hosts subscribe to that event for branded email or downgrade UX. The
  built-in `downgrade` action calls `assignPlan(defaultPlan)`; `block` is
  a no-op today and reserved for a future header-based UI banner.

## Webhook reliability

The receiver is idempotent end-to-end:

```
Stripe ─► /webhooks/stripe ─► HMAC verify ─► insert stripe_processed_events ON CONFLICT DO NOTHING
                                              │
                                              ├─ (rowCount=0) duplicate ──► return 200
                                              └─ (rowCount=1) ──► dispatch ProcessStripeEventJob
                                                                       │
                                                                       └─ retrieve event from Stripe (re-fetch)
                                                                            ├─ ordering guard via last_event_at
                                                                            ├─ syncSubscription / dispatch table
                                                                            └─ mark stripe_processed_events.completed
```

Operator surface:

- `tenant:billing:sync` — daily cron, reconciles drift from missed webhooks.
- `tenant:billing:cleanup` — purges `stripe_processed_events` older than
  `webhook.idempotencyTtlDays` (default 90).
- `tenant:billing:replay --event-id=evt_xxx` — manually retry a failed
  event after fixing the underlying issue (e.g. missing product mapping).
- `tenant:billing:doctor --json` — config sanity check + Stripe API ping
  + scan for stale `failed` events. Pipeline-friendly (exit 1 on error).

## Local development

```bash
# Forward Stripe webhooks to your local app:
stripe listen --forward-to localhost:3333/webhooks/stripe

# Trigger an event without leaving the terminal:
stripe trigger customer.subscription.created
```

For tests in CI without `stripe listen` running, use the package helper:

```bash
node ace tenant:billing:test-webhook customer.subscription.created
```

…which builds and signs a synthetic event and POSTs it to the local
endpoint. Replace the customer/product IDs in the template (or pass
`--object=path/to/body.json`) for an end-to-end run.

For unit tests, the package ships a `MockStripe` SDK double:

```ts
import { MockStripe, signWebhookPayload } from '@adonisjs-lasagna/saas-tenancy/testing'

const mock = new MockStripe('whsec_test_secret')
mock.injectEvent({ id: 'evt_test', type: 'customer.subscription.created', data: {…} })
```

## Metered (usage-based) billing

Two ways to feed Stripe meters:

### Manual

```ts
const billing = await app.container.make(BillingService)
await billing.reportUsage(tenant, { eventName: 'api_request' }, 1)
```

Each call writes a row to `stripe_meter_events` with a UNIQUE
idempotency key, then forwards to Stripe with the same key — retries
under network blips never produce duplicate meter events.

### Auto-bridge

```ts
billing: {
  usageMapping: {
    apiRequests: { meterEventName: 'api_request' },
  },
},
plans: {
  emitTracked: true,
  // …
},
```

With both flags on, `QuotaService.track` (and the allowed branch of
`consume`) emits a `QuotaTracked` event. The bridge listener aggregates
hits per `(tenant, meter)` in memory and flushes a single
`ReportUsageBatchJob` every `batchFlushMs` (default 10s). On
`provider.shutdown()` the listener drains its remaining buckets so a
clean SIGTERM doesn't drop in-flight metering.

## Production checklist

1. Live key in Stripe with a webhook endpoint pointing at `/webhooks/stripe`.
2. `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION` in env.
3. `tenant:billing:doctor` returns exit 0.
4. Cron: daily `tenant:billing:sync` and `tenant:billing:cleanup`.
5. Subscribe a paging integration to `BillingEventDeadLettered`.
6. (Optional) Set `webhook.enforceIpAllowlist=true` and supply
   `webhook.allowedIps` for defence-in-depth on the HMAC check.
7. (Optional) Pre-load Grafana dashboards from
   `billing.webhook.processing_duration_seconds`,
   `billing.subscription.active_total`, `billing.stripe_api.errors_total`.

## Read next

- [Quotas satellite](/docs/satellites/quotas)
- [Webhooks satellite](/docs/satellites/webhooks) for *outbound* events to
  your tenants (separate from this *inbound* Stripe receiver).
