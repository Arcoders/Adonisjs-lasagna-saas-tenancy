# @adonisjs-lasagna/billing

Multi-provider billing (Stripe, Paddle, Lemon Squeezy) for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy):
one driver contract behind the signed-webhook pipeline (verify -> idempotency ->
`ProcessBillingEventJob`), subscription lifecycle events, metered-usage
reporting, dunning, the `BillingService`, the provider-agnostic satellite models,
and the `tenant:billing:*` ace commands.

[![Stability: experimental](https://img.shields.io/badge/stability-experimental-C26A4B)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Stability: experimental.** This package ships `0.1.0` and carries no semver promise: the API may change in any minor. It is covered by tests and green in CI, but it has no production mileage. Pin the exact version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

It was split out of the core so a provider-side change (or CVE) versions on its
own cadence and is only installed by apps that bill. Pick a provider with
`config.billing.driver`; `stripe` is an optional peer (install it only for the
Stripe driver — Paddle and Lemon Squeezy call their REST APIs directly).

## Install

```bash
# Stripe driver:
npm i @adonisjs-lasagna/billing @adonisjs-lasagna/saas-tenancy stripe
# Paddle or Lemon Squeezy driver (no SDK):
npm i @adonisjs-lasagna/billing @adonisjs-lasagna/saas-tenancy

node ace configure @adonisjs-lasagna/billing
node ace migration:run
```

`@adonisjs-lasagna/saas-tenancy` (the core) is a required peer. `node ace
configure` registers the provider and commands, publishes the billing migrations,
scaffolds the quota mailer/view, and prints the webhook-route reminder — so run
`migration:run` afterwards. See the
[billing guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/billing)
for the exact `migration:run` connection flag. An opt-in fiscal mode
(`LASAGNA_BILLING_FISCAL=1` before `configure`) publishes two extra migrations.

## Wire it up

`node ace configure` already registered the provider and commands in
`adonisrc.ts`. The one step it can't do is patch your routes file, so mount the
webhook route yourself:

```ts
// start/routes.ts
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
multitenancyBillingRoutes()
```

The provider replaces what the core used to do: it registers `BillingService`,
seeds + verifies the active driver's config on boot, wires the usage / quota /
tenant-delete listeners on start, and drains the metering aggregator on shutdown.

## Configuration

The `billing` block lives on the host's `config/multitenancy.ts`. Importing this
package augments core's `MultitenancyConfig` (through `SatelliteConfigRegistry`
declaration merging), so `config.billing` is typed wherever billing is installed,
while core itself stays free of the billing shape. Type the whole object with
`MultitenancyConfigWithBilling`, or author the block on its own with the
`defineBillingConfig` helper:

```ts
// config/multitenancy.ts (billing block)
billing: {
  driver: 'stripe', // 'stripe' | 'paddle' | 'lemonsqueezy'
  stripe: {
    apiKey: env.get('STRIPE_API_KEY'),
    webhookSecret: env.get('STRIPE_WEBHOOK_SECRET'),
  },
  // paddle: { ... } or lemonSqueezy: { ... }
  // note: the lemonsqueezy driver's config block key is camelCase `lemonSqueezy`.
  products: { prod_pro: 'pro', prod_team: 'team' }, // provider product/price id -> plan key
  defaultPlan: 'pro',
},
```

The webhook path (default `/webhooks/billing`) must be listed in
`config.ignorePaths` so the signed-webhook body reaches the verifier unparsed. See
the [billing guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/billing)
for the exhaustive configuration reference.

## Migrating from the core barrels

`BillingService`, `redactBillingEvent`, the satellite models, the subscription /
payment events, `BillingException`, the webhook middleware, the billing jobs,
`MockStripe` / `signWebhookPayload`, and `multitenancyBillingRoutes` all moved
here:

```diff
- import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
- import { multitenancyBillingRoutes } from '@adonisjs-lasagna/saas-tenancy/health'
+ import { BillingService, multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
```

The billing config (`config.billing`) and the Stripe data types still live in
the core config object; only the runtime moved.

## Full documentation

<https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/billing>
