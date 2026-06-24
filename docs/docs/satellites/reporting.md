---
title: Reporting satellite
description: Extensible cross-tenant analytics over the backoffice schema — usage by period, top-N tenant rankings, custom named metrics, host-defined report extensions, and a mountable dashboard, all isolation-safe by construction.
---

# Reporting

`@adonisjs-lasagna/reporting` answers fleet-wide questions the per-tenant APIs
can't: *how much traffic across all tenants this week? which tenants are the
heaviest? what's the platform error rate? how many bookings did the whole fleet
take?* It aggregates the backoffice `tenant_metrics` table the core metrics
pipeline writes, plus any **custom named metrics** your app emits, and it lets
you register your own **report extensions**.

Aggregating in the shared `backoffice` schema is **isolation-safe by
construction** — these queries never enter a tenant's `search_path`. A built-in
`assertNotInTenantScope()` guard refuses to run if called inside `tenancy.run()`,
so a reporting query can never leak cross-tenant data into a tenant context.

Requires **PostgreSQL 13+** (`DATE_TRUNC`).

## Install

```bash
npm install @adonisjs-lasagna/reporting
node ace configure @adonisjs-lasagna/reporting
```

The configure hook registers the provider. Reporting reads `tenant_metrics` (and,
for custom metrics, `tenant_custom_metrics`) in the backoffice schema — run the
core migrations so those tables exist.

## The metrics pipeline (wire it once)

Reporting reads three real metrics — `request_count`, `error_count`,
`bandwidth_bytes` — but **the host owns emission**. Two opt-in pieces feed them:

1. Register the auto-metrics middleware so every request is counted:

   ```ts
   // start/kernel.ts — add to your router or a route group
   import { TrackMetricsMiddleware } from '@adonisjs-lasagna/saas-tenancy/middleware'
   router.use([() => new TrackMetricsMiddleware().handle])
   ```

   It records one request, an error on a `>= 500` response, and the response
   bandwidth against the resolved tenant. Recording is **fail-open** — a metrics
   backend hiccup never breaks a request.

2. Schedule the flush so Redis counters land in the backoffice tables:

   ```bash
   node ace tenant:metrics:flush   # run on a cron, e.g. every 5 minutes
   ```

   This flushes **both** the built-in counters and your custom metrics.

## Service

```ts
import app from '@adonisjs/core/services/app'
import { ReportingService } from '@adonisjs-lasagna/reporting'

const reporting = await app.container.make(ReportingService)

// Totals + error rate per day/week/month bucket (newest first).
const byWeek = await reporting.getAggregate({ period: 'week', since: '2026-06-01' })

// Busiest tenants over the window.
const top = await reporting.getTopTenants({ limit: 10 })

// Stream every tenant + its usage, busiest first.
for await (const { tenant, usage } of reporting.iterateTenantsByUsage()) {
  console.log(tenant.name, usage.requests)
}
```

`AggregationOptions`: `period` (`'day' | 'week' | 'month'`, default `day`),
`since`/`until` (ISO `YYYY-MM-DD`, default last 30 days), `limit` (top-N cap,
default 50, max 1000).

Call these from a backoffice context — a queue job, a scheduled task, or an admin
endpoint — never inside `tenancy.run()` (the guard throws).

## Custom metrics

Track your own domain metrics (bookings, revenue, jobs, …) the same isolation-safe
way the built-ins work: **emit a named metric**, and reporting aggregates it
cross-tenant from the backoffice schema. No per-tenant table fan-out, no raw SQL.

Emit wherever it makes sense in your app (values are integers — use minor units
like cents for money):

```ts
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'

const metrics = new MetricsService()
await metrics.emitMetric(tenant.id, 'rental_bookings', 1)
await metrics.emitMetric(tenant.id, 'revenue_cents', 1299)
```

`tenant:metrics:flush` writes them to `backoffice.tenant_custom_metrics`. Then
aggregate cross-tenant:

```ts
// One metric, any whitelisted aggregation (sum | avg | count | max | min).
const total = await reporting.getCustomAggregate({ name: 'rental_bookings', aggregation: 'sum' })

// Per-name totals across the fleet (also included in the dashboard payload).
const breakdown = await reporting.getCustomMetricsBreakdown({ since: '2026-06-01' })
```

Metric names must be safe identifiers (`/^[a-zA-Z0-9_-]{1,63}$/`); the aggregation
is whitelisted, so neither can inject SQL. Emitting an `emitMetric` dispatches a
`MetricRecorded` event other satellites can subscribe to.

Optionally declare metadata (a label + default aggregation) in config — it's
metadata only; **unregistered names still aggregate** (default `SUM`):

```ts
// config/multitenancy.ts
import { defineReportingConfig } from '@adonisjs-lasagna/reporting'

export default defineConfig({
  // …core config…
  reporting: defineReportingConfig({
    metrics: [
      { name: 'rental_bookings', aggregation: 'count', description: 'Confirmed bookings' },
      { name: 'revenue_cents', aggregation: 'sum' },
    ],
  }),
})
```

## Report extensions

Register custom reports without touching package code. Implement `ReportExtension`
and register it in your provider's `boot()`:

```ts
// app/reports/top_properties.ts
import type { ReportExtension } from '@adonisjs-lasagna/reporting'

export class TopPropertiesReport implements ReportExtension {
  name = 'top_properties'
  description = 'Top 5 most-booked properties'
  async execute(filters: { since?: string; until?: string }) {
    // your query / aggregation here
    return { rows: [/* … */] }
  }
}

// a provider boot()
const registry = await app.container.make(ReportExtensionRegistry)
registry.register(new TopPropertiesReport())
```

Run it from the CLI (`node ace tenant:report:generate --extension=top_properties`)
or the endpoint (`GET {prefix}/reports/extension/top_properties`).

::: warning Extensions own their own isolation
Built-in reporting reads the shared backoffice schema and never enters a tenant
scope. An extension that fans out across **tenant schemas** (one query per tenant)
is your responsibility: bound it with the `TenantQueueService.statsForTenants`
concurrency pattern and mind the connection budget (see
[Scaling limits](/docs/scaling-limits)). The built-in cross-tenant guard protects
only the built-in aggregations.
:::

## Dashboard endpoint

Mount the read-only dashboard with your own admin auth. It exposes fleet-wide
analytics, so it is **fail-closed**: `multitenancyReportingRoutes` requires a
`middleware`, and throws at startup if you omit it. Pass `middleware: false` only
to mount it public on purpose (behind a trusted network boundary).

```ts
// start/routes.ts
import { multitenancyReportingRoutes } from '@adonisjs-lasagna/reporting'
import { middleware } from '#start/kernel'

multitenancyReportingRoutes({
  prefix: '/admin/reporting',
  middleware: [middleware.auth(), middleware.role('owner')],
  cacheTtlMs: 30_000,   // optional: cache dashboard responses (global scope) for 30s
  maxRangeDays: 366,    // optional: reject over-wide / inverted windows with 400
  openapi: true,        // optional: mount {prefix}/openapi.json + {prefix}/docs
})
```

`GET /admin/reporting/dashboard?period=week&since=…&until=…&limit=20` returns
`{ data: { aggregate, topTenants, customMetrics } }`. Invalid `period`, non-ISO
`since`/`until`, or an over-wide/inverted window return `400`.

Caching is **global** (cross-tenant) by design — never tenant-scoped. It's a stale
window: within `cacheTtlMs`, a repeated query is served from cache.

## Command

```bash
node ace tenant:report:generate --period=week --top=10
node ace tenant:report:generate --format=csv --out=usage.csv
node ace tenant:report:generate --extension=top_properties
```

`--format` is `table` (default), `json`, or `csv`; `--out` writes to a file
instead of stdout; `--extension` runs a registered report extension.

## Prepared for future iterations

Not built yet, but on the roadmap: configurable dashboard panels (a backend
contract + a `reporting-ui` satellite), a metrics-management CLI
(`tenant:reporting:metrics:list`), and pre-computed rollup tables for very large
fleets (live aggregation only today).

## Read next

- [Metrics satellite](/docs/satellites/metrics) — the per-tenant counters this aggregates.
- [Resilience](/docs/resilience) — reporting's failure modes and recovery.
- [Compliance](/compliance) — per-tenant audit export (a different, single-tenant view).
