---
title: Upgrade to 1.0
description: Migrate from 0.x to 1.0 — the satellite packages and the unified tenant-resolution default.
---

# Upgrade to 1.0

Two things change in 1.0, and both are mechanical:

1. The optional satellites (billing, SSO, the admin REST API, backup/clone) moved
   out of the core into their own packages. You install the ones you use and
   update a handful of imports.
2. `resolver.legacyAdapterFallback` now defaults to `false`, so raw model queries
   that run outside an active tenant context route through the resolver chain.

The core keeps every tenancy primitive plus the leaf satellites (audit, feature
flags, metrics, webhooks, branding, quotas, impersonation). If you only use those,
the only thing to check is the resolver default at the end.

## What 1.0 promises (and what it doesn't)

1.0 narrows its promise on purpose. The isolation **core** is a release
candidate: feature complete and green in CI, with the `stable` label withheld
until an independent security review and production mileage close. The satellites
(billing, SSO, the admin REST API, backup, and the opt-in in-core features like
quotas, webhooks, and metrics) are **experimental** and are not covered by the
1.x semver promise, so they may change in a minor release. The full breakdown and
the per-tier rules are in the [stability matrix](/docs/stability). Pin your
versions accordingly and check the changelog before upgrading an experimental
surface.

## 1. Install the satellites you use

```bash
npm i @adonisjs-lasagna/admin @adonisjs-lasagna/sso @adonisjs-lasagna/billing @adonisjs-lasagna/backup
```

Install only what you actually import. Each package declares the core as a peer,
so it tracks the core version you already have.

## 2. Update imports

### Admin REST API → `@adonisjs-lasagna/admin`

```ts
// Before
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/saas-tenancy/admin'
// After
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
```

The old `/admin` subpath stays as a throwing shim for one minor and then drops, so
a missed import fails with a clear "moved to @adonisjs-lasagna/admin" message
rather than a silent miss.

The admin routes are also **fail-closed** now: pass `middleware` to guard them, or
`middleware: false` to mount them public on purpose. Omitting both throws at boot.

```ts
router.group(() => {
  multitenancyAdminRoutes({ middleware: [middleware.auth()] }) // guarded
})
```

### SSO → `@adonisjs-lasagna/sso`

```ts
// Before
import { SsoService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantSsoConfig } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
// After
import { SsoService, TenantSsoConfig } from '@adonisjs-lasagna/sso'
```

There is no shim here (these came from shared barrels), so update the imports
directly. The `create_tenant_sso_configs_table` migration stub still ships with
the core, so `node ace configure --with=sso` keeps provisioning the table.

### Billing → `@adonisjs-lasagna/billing`

```ts
// Before
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/saas-tenancy/health'
// After
import { BillingService } from '@adonisjs-lasagna/billing'
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
```

The Stripe models, the billing events and jobs, `BillingException`,
`VerifyStripeWebhookMiddleware`, `billingHealthCheck`, and the `MockStripe` /
`signWebhookPayload` testing helpers all move with it.

Register the provider and the commands in `adonisrc.ts` alongside the core's:

```ts
providers: [
  () => import('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'),
  () => import('@adonisjs-lasagna/billing/provider'),
],
commands: [
  () => import('@adonisjs-lasagna/saas-tenancy/commands'),
  () => import('@adonisjs-lasagna/billing/commands'),
],
```

The provider does what the core used to do for billing: it validates the Stripe
config at boot, wires the quota/usage/tenant-delete listeners, registers the
billing jobs with the queue, and drains metering on shutdown. The Stripe config
types stay in the core, so `config.billing` is still typed.

### Backup, clone, restore, SQL import → `@adonisjs-lasagna/backup`

```ts
// Before
import { BackupService, CloneService } from '@adonisjs-lasagna/saas-tenancy/services'
// After
import { BackupService, CloneService } from '@adonisjs-lasagna/backup'
```

The `BackupTenant` / `RestoreTenant` / `CloneTenant` jobs and the `tenant:backup`,
`tenant:backup:list`, `tenant:restore`, `tenant:import`, `tenant:clone`,
`tenant:backups:run` commands move with the package. Register the provider and
commands:

```ts
providers: [
  // ...core provider
  () => import('@adonisjs-lasagna/backup/provider'),
],
commands: [
  // ...core commands
  () => import('@adonisjs-lasagna/backup/commands'),
],
```

The provider registers the backup queue jobs and the `backup_recency` doctor
check, so without it `tenant:doctor` simply won't run the backup check and a
dispatched backup job would dead-letter.

`@aws-sdk/client-s3` is an optional peer of this package; install it only if you
use S3 archival.

### Result types stay in the core

`BackupMetadata` and `CloneResult` are carried by the core's tenant-lifecycle
hooks and the `TenantBackedUp` / `TenantCloned` events, so they live in the core:

```ts
import type { BackupMetadata, CloneResult } from '@adonisjs-lasagna/saas-tenancy/types'
```

The implementing services come from `@adonisjs-lasagna/backup`; the types come
from the core. The `backup`/`restore`/`clone` hook phases and the lifecycle
events themselves are unchanged.

## 3. Check the resolver default

`resolver.legacyAdapterFallback` now defaults to `false`. When a raw model query
runs **outside** an active tenant context (no `request.tenant()`/guard has run and
no `tenancy.run()` scope is open), `TenantAdapter` resolves the tenant id through
the resolver chain synchronously instead of the `resolverStrategy`-only switch.

You are **not** affected if you use a single built-in `resolverStrategy` with no
custom `resolverChain`: the chain `[resolverStrategy]` resolves to the same id as
the old switch, and HTTP requests resolve through the guard either way.

You **are** affected if you registered a custom `resolverChain` whose result
differs from `resolverStrategy` and you query tenant models outside the request
guard. That is the case 1.0 fixes. To keep the old behavior:

```ts
export default defineConfig({
  resolver: {
    legacyAdapterFallback: true, // restore the 0.x resolverStrategy-only fallback
  },
})
```

See [Tenant identification](/docs/tenant-identification) for the full routing
model.

## 4. Rebuild and run your tests

After updating imports and `adonisrc.ts`, a typecheck surfaces anything left
pointing at a moved symbol (the shimmed `/admin` path throws at runtime with a
migration message; the others fail at compile time). Run your suite to confirm the
provider wiring for billing and backup is in place.
