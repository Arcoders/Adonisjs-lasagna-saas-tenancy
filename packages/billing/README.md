# @adonisjs-lasagna/billing

Multi-provider billing (Stripe, Paddle, Lemon Squeezy) for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy):
one driver contract behind the signed-webhook pipeline (verify -> idempotency ->
`ProcessBillingEventJob`), subscription lifecycle events, metered-usage
reporting, dunning, the `BillingService`, the provider-agnostic satellite models,
and the `tenant:billing:*` ace commands.

[![Stability: experimental](https://img.shields.io/badge/stability-experimental-E0A106)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Experimental.** This satellite works and is covered by tests, but it is not part of the 1.x stability promise: its surface may change in a minor release. Pin the version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

It was split out of the core so a provider-side change (or CVE) versions on its
own cadence and is only installed by apps that bill. Pick a provider with
`config.billing.driver`; `stripe` is an optional peer (install it only for the
Stripe driver — Paddle and Lemon Squeezy call their REST APIs directly).

## Install

```bash
# Stripe driver:
npm i @adonisjs-lasagna/billing stripe
# Paddle or Lemon Squeezy driver (no SDK):
npm i @adonisjs-lasagna/billing
```

It declares `@adonisjs-lasagna/saas-tenancy` as a peer, so install the core
package too.

## Wiring

Register the provider and commands in `adonisrc.ts` (alongside the core
provider), and mount the webhook route:

```ts
// adonisrc.ts
providers: [
  // ...
  () => import('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'),
  () => import('@adonisjs-lasagna/billing/provider'),
],
commands: [
  () => import('@adonisjs-lasagna/saas-tenancy/commands'),
  () => import('@adonisjs-lasagna/billing/commands'),
],
```

```ts
// start/routes.ts
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
multitenancyBillingRoutes()
```

The provider replaces what the core used to do: it registers `BillingService`,
seeds + verifies the active driver's config on boot, wires the usage / quota /
tenant-delete listeners on start, and drains the metering aggregator on shutdown.

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
