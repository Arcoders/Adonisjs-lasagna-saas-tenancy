# @adonisjs-lasagna/billing

Stripe billing for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy):
the signed-webhook pipeline (verify -> idempotency -> `ProcessStripeEventJob`),
subscription lifecycle events, metered-usage reporting, dunning, the
`BillingService`, the Stripe satellite models, and the `tenant:billing:*` ace
commands.

It was split out of the core so a Stripe-side change (or CVE) versions on its
own cadence and is only installed by apps that bill through Stripe. `stripe` is
an optional peer.

## Install

```bash
npm i @adonisjs-lasagna/billing stripe
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
verifies the Stripe config on boot, wires the usage / quota / tenant-delete
listeners on start, and drains the metering aggregator on shutdown.

## Migrating from the core barrels

`BillingService`, `redactStripeEvent`, the Stripe models, the subscription /
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
