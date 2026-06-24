---
title: Quotas
description: Plan-bound limits served as middleware. Rolling-day counters and snapshot watermarks; over-quota requests get HTTP 429.
---

# Quotas

Per-plan limits enforced via the `enforceQuota` middleware factory. Two
counter modes: **rolling-day** (a per-day counter keyed by the UTC calendar
date, reset at 00:00 UTC, that you increment on every request) and
**snapshot** (a watermark you update when something external changes, like
seats or storage). Over-quota requests respond with
HTTP **429 Too Many Requests** (`E_TENANT_QUOTA_EXCEEDED`).

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=quotas
```

This publishes the `tenant_plans` backoffice migration. Adding quotas to an
app that is already running? See
[Adding features later](/docs/cookbook/adding-features-incrementally).

## Plans

Plan *definitions* (names + limits) are declared in
`config/multitenancy.ts` under the `plans` key. Which plan a tenant is
*on* resolves through `plans.storage`:

- `'config-only'`: your `plans.getPlan(tenant)` callback decides;
  `assignPlan()` is a no-op.
- `'tenant_plans'`: assignments live in the backoffice `tenant_plans`
  table; `QuotaService.assignPlan(tenant, plan)` writes it (this is
  what the billing satellite calls when a subscription changes), and
  resolution falls back to that row when `getPlan` is undefined.
- `'auto'` (default): probe at boot, using the table if it exists, else
  config-only.

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
used by both rolling and snapshot quotas; the mode is decided by which
service method you call (`track` vs. `setUsage`), not by the plan
config.

## Middleware

The package exports an `enforceQuota(quotaName, options?)` factory.
Apply it per-route, not globally; `TenantGuardMiddleware` must run
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
> script execution, concurrent callers cannot over-grant the quota;
> the limit is enforced exactly. Snapshot quotas (`setUsage`) are
> not part of this atomic check; enforce those at the write site.

## Redis outages (degradation policy)

`consume` and `track` reach Redis through the
[resilience policy](/docs/resilience), so a Redis outage follows
`config.resilience.redis.quota` rather than failing in an ad-hoc way:

- **`fail-open`** (the default): `consume` returns `0` and skips enforcement,
  and a `DependencyDegraded` event fires. Availability wins, but the limit is
  not enforced during the outage, so subscribe to the event and alert on a
  burst. This replaces the old silent no-op.
- **`fail-closed`**: `consume` throws `DependencyUnavailableException` (503 +
  `Retry-After`). Correctness wins, and the caller gets a clean degraded
  response.

Set the policy in `config.resilience.redis.quota`. See
[Configuration → Resilience](/docs/configuration#resilience-degradation-policy)
and [Troubleshooting](/docs/gotchas#fail-open-quotas-silently-stop-enforcing).

## Counter modes

| Mode | Helper | Reset behaviour |
|---|---|---|
| `rolling-day` (default) | `track` / `consume` | Fixed UTC calendar-day bucket: the Redis key is dated `YYYY-MM-DD` (UTC) and resets at 00:00 UTC. The 48-hour TTL just garbage-collects the previous day's key. It is **not** a sliding window, so a tenant can spend the full limit on each side of midnight UTC (worst case ~2× the daily limit across the boundary). Suitable for per-day allowances like "API calls per day". |
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
**counters are not reset**; a tenant upgrading from `starter` to `pro`
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

There is no endpoint to assign a plan; the plan is resolved by your
`plans.getPlan(tenant)` callback, so the source of truth is wherever
you store the tenant's plan column / metadata.


## Read next

- [Lifecycle events](/docs/events); the `TenantQuotaExceeded` event.
- [Configuration](/docs/configuration); the plan and quota options.
- [Production checklist](/docs/production-checklist); the hardening runbook before you ship.
- [Satellites](/docs/satellites/); the rest of the opt-in features.
