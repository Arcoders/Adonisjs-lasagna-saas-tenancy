---
title: Quotas
description: Plan-bound limits served as middleware. Rolling-day counters and snapshot watermarks; over-quota requests get HTTP 429.
---

# Quotas

Per-plan limits enforced via the `enforceQuota` middleware factory. Two
counter modes: **rolling-day** (a 48-hour TTL counter you increment on
every request) and **snapshot** (a watermark you update when something
external changes — seats, storage). Over-quota requests respond with
HTTP **429 Too Many Requests** (`E_TENANT_QUOTA_EXCEEDED`).

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=quotas
```

## Plans

Plans are declared **statically in `config/multitenancy.ts`** under the
`plans` key. There is no `upsertPlan` / `assignPlan` API — pick the
plan for a tenant by returning its name from `plans.getPlan(tenant)`.

```ts
// config/multitenancy.ts
import { defineConfig } from '@adonisjs-lasagna/saas-tenancy'

export default defineConfig({
  // …
  plans: {
    defaultPlan: 'starter',
    definitions: {
      starter: { limits: { apiRequests: 10_000, storageMb: 5_000 } },
      pro:     { limits: { apiRequests: 1_000_000, storageMb: 50_000 } },
    },
    getPlan: async (tenant) => tenant.metadata?.plan ?? 'starter',
  },
})
```

`PlanDefinition.limits` is `Record<string, number>`. The same key is
used by both rolling and snapshot quotas — the mode is decided by which
service method you call (`track` vs. `setUsage`), not by the plan
config.

## Middleware

The package exports an `enforceQuota(quotaName, options?)` factory.
Apply it per-route, not globally — `TenantGuardMiddleware` must run
first so `request.tenant()` is available.

```ts
// start/routes.ts
import { enforceQuota } from '@adonisjs-lasagna/saas-tenancy/middleware'

router
  .post('/api/messages', '#controllers/messages.create')
  .use(enforceQuota('apiRequests'))

// Soft mode — track usage but never reject:
router
  .get('/api/usage-tracked', '#controllers/usage.show')
  .use(enforceQuota('apiRequests', { enforce: false }))

// Increment by more than 1:
router
  .post('/api/upload', '#controllers/uploads.create')
  .use(enforceQuota('uploads', { amount: 1 }))
```

The middleware:

1. Resolves the active tenant via `request.tenant()`.
2. Looks up `getLimit(tenant, quotaName)` from the active plan.
3. Calls `consume(tenant, quotaName, amount)`, which checks the current
   counter and increments it.
4. Throws `QuotaExceededException` (HTTP 429) when the increment would
   exceed the limit.

> **Atomicity.** `consume` runs a single Redis `EVAL` (Lua) script
> that GETs the counter, compares against the limit, and `INCRBY`s
> only when the increment would still fit. Because Redis serializes
> script execution, concurrent callers cannot over-grant the quota —
> the limit is enforced exactly. Snapshot quotas (`setUsage`) are
> not part of this atomic check; enforce those at the write site.

## Counter modes

| Mode | Helper | Reset behaviour |
|---|---|---|
| `rolling-day` (default) | `track` / `consume` | Redis key with 48-hour TTL after the last write. Suitable for "API calls in the last 24h". |
| `snapshot` | `setUsage` | No TTL. The app reports the new value (seats, storageMb) when it changes. |

```ts
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
const quotas = await app.container.make(QuotaService)

// Rolling-day counter:
await quotas.track(tenant, 'apiRequests', 1)

// Snapshot watermark:
await quotas.setUsage(tenant, 'storageMb', 4_812)
```

## Watching usage

```ts
const used = await quotas.getUsage(tenant, 'apiRequests')
const snapshot = await quotas.snapshot(tenant)
// { plan: 'starter', limits: { apiRequests: 10000, ... }, usage: { apiRequests: 8421, ... } }
```

`getUsage()` returns the rolling-day counter first; if there is none,
it falls back to the snapshot value.

## Plan upgrades

Plan resolution happens on every request (`getPlan(tenant)`). Changing
the plan resolver's return value shifts the limits immediately, but the
**counters are not reset** — a tenant upgrading from `starter` to `pro`
keeps its existing usage and just gets more headroom. To zero a counter
explicitly, call `quotas.reset(tenant, quotaName)` or use the admin
endpoint below.

## Admin REST

Three endpoints under `/admin/multitenancy`:

```http
GET    /admin/multitenancy/tenants/{id}/quotas         # plan + limits + usage
PUT    /admin/multitenancy/tenants/{id}/quotas/usage   # set a snapshot value
POST   /admin/multitenancy/tenants/{id}/quotas/reset   # reset rolling + snapshot
```

There is no endpoint to assign a plan — the plan is resolved by your
`plans.getPlan(tenant)` callback, so the source of truth is wherever
you store the tenant's plan column / metadata.
