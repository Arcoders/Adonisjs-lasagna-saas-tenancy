---
title: Upgrade to 0.3
description: Migrate from 0.2.x to 0.3.0; the satellite packages and the unified tenant-resolution default.
---

# Upgrade to 0.3

Three things change in `0.3.0`, and all are mechanical:

1. The optional satellites (billing, SSO, the admin REST API, backup/clone) moved
   out of the core into their own packages. You install the ones you use and
   update a handful of imports.
2. Tenant resolution is unified behind the resolver chain: a raw model query that
   runs outside an active tenant context resolves its id through the same chain
   `request.tenant()` uses, and every resolver returns a canonical UUID v4.
3. Several surfaces flip to their safe posture by default: `/metrics` is
   fail-closed, custom domains are strict, and `request.tenant()` rejects
   suspended/deleted tenants on its own. Each has a one-line opt-out if you
   relied on the old behavior; see
   [the safe-by-default changes](#_4-adopt-the-safe-by-default-changes).

The core keeps every tenancy primitive plus the leaf satellites (audit, feature
flags, metrics, webhooks, branding, quotas, impersonation). If you only use those,
the only thing to check is the resolver default at the end.

## What 0.3 promises (and what it doesn't)

`0.3.0` narrows its promise on purpose. Everything here is pre-1.0, so semver
formally promises nothing across a minor. The isolation **core** is a release
candidate: feature complete and green in CI, with the `stable` label and the
`1.0.0` version both withheld until an independent security review and production
mileage close. The satellite **packages** (billing, SSO, backup, reporting, AI)
ship `0.1.0` and are **experimental**: each cleared the same graduation gate as the
core (frozen Satellite ABI, its own merged coverage floor, doc page, CHANGELOG),
but none has been installed by anyone yet. The opt-in **in-core features** (quotas,
webhooks, metrics, audit logs, branding, feature flags, impersonation) are
experimental too. The full breakdown and the per-tier rules are in the
[stability matrix](/reference/stability). Pin your versions, and check the changelog
before every upgrade.

## 1. Install the satellites you use

```bash
npm i @adonisjs-lasagna/sso @adonisjs-lasagna/billing @adonisjs-lasagna/backup
```

The admin REST API and the WebSockets satellite are **not published to npm**.
Vendor them or depend on a git reference.

Install only what you actually import. Each package declares the core as a peer,
so it tracks the core version you already have.

## 2. Update imports

### Admin REST API → `@adonisjs-lasagna/admin`

<!-- compile: skip -->

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

<!-- compile: skip -->

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

<!-- compile: skip -->

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

<!-- compile: skip -->

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

Tenant resolution has one authority now: the resolver chain. When a raw model
query runs **outside** an active tenant context (no `request.tenant()`/guard has
run and no `tenancy.run()` scope is open), `TenantAdapter` walks that same chain
synchronously instead of a separate `resolverStrategy`-only switch, so a custom
`resolverChain` routes those fallback queries too. There is no
`legacyAdapterFallback` flag to opt out of.

You are **not** affected if you use a single built-in `resolverStrategy` with no
custom `resolverChain`: the chain `[resolverStrategy]` resolves the same id, and
HTTP requests resolve through the guard either way.

Resolution also enforces one UUID policy at the border: a `header`, `subdomain`,
or `path` value that is not a canonical UUID v4 falls through (a later resolver in
the chain can still match) instead of forging an id, and a mixed-case UUID is
canonicalized to lowercase so it maps to one connection, one resolution-cache
entry, and one rate-limit bucket. If you attributed tenants by opaque non-UUID
ids, move to UUID v4 tenant ids; the package already required them downstream.

See [Tenant identification](/guides/tenant-identification) for the full routing
model.

## 4. Adopt the safe-by-default changes

1.0 flips three surfaces to their secure posture. Each is a one-line change if
you relied on the previous default.

### `/metrics` requires a middleware (or an explicit opt-out)

The Prometheus output carries per-tenant labels and tenant counts by status, so
a bare `multitenancyRoutes()` with metrics enabled now **throws at boot** instead
of mounting `/metrics` public:

```ts
// Before (0.x): mounted /metrics public
multitenancyRoutes()

// After (1.0): pick one
multitenancyRoutes({ metricsMiddleware: middleware.auth() }) // gated (recommended)
multitenancyRoutes({ metricsMiddleware: false }) // public ON PURPOSE (trusted network)
multitenancyRoutes({ metrics: false }) // no /metrics endpoint
```

Conditional values that are effectively absent (`[]`, `''`) are rejected too.
Remember your Prometheus scrape job now needs the credential. See
[Health & metrics](/guides/health).

### Custom domains are strict

A request whose tenant header conflicts with the tenant of a verified custom
domain is rejected with 400 before any handler runs; the domain is
authoritative. If you deliberately route by header on managed domains:

```ts
// Restore the 0.x header-wins behavior (understand the trade-off first)
middleware.customDomain({ strict: false })
```

See [Routing's strict mode](/guides/routing#strict-mode-the-default).

### `request.tenant()` rejects suspended and soft-deleted tenants

The macro now throws a 403 (`E_TENANT_SUSPENDED`) for an inactive tenant before
opening any connection, even on routes without the guard middleware. Admin or
recovery flows that legitimately load inactive tenants opt in:

```ts
const tenant = await request.tenant({ allowInactive: true })
```

### Related: `tenant:import` is all-or-nothing by default

In `@adonisjs-lasagna/backup`, the SQL importer now aborts and rolls back on the
first failing statement. Pass `--continue-on-error` to restore per-statement
savepoints (which can leave a partial import), and watch for the new warnings
when the schema rewrite touches a string literal.

## 5. Rebuild and run your tests

After updating imports and `adonisrc.ts`, a typecheck surfaces anything left
pointing at a moved symbol (the shimmed `/admin` path throws at runtime with a
migration message; the others fail at compile time). Run your suite to confirm the
provider wiring for billing and backup is in place.

## Read next

- [Release notes](/reference/release-notes); the per-version changelog.
- [Stability](/reference/stability); the labels that govern future changes.
- [Roadmap](/reference/roadmap); where the project is headed.
