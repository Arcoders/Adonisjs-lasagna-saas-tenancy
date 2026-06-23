---
title: Reporting satellite
description: Cross-tenant analytics over the backoffice tenant_metrics table — aggregated usage by period, top-N tenant rankings, and a mountable dashboard endpoint, all isolation-safe by construction.
---

# Reporting (experimental)

`@adonisjs-lasagna/reporting` answers fleet-wide questions the per-tenant APIs
can't: *how much traffic across all tenants this week? which tenants are the
heaviest? what's the platform error rate?* It aggregates the backoffice
`tenant_metrics` table the core metrics pipeline already writes.

Aggregating in the shared `backoffice` schema is **isolation-safe by
construction** — these queries never enter a tenant's `search_path`. A built-in
`assertNotInTenantScope()` guard refuses to run if called inside `tenancy.run()`,
so a reporting query can never leak cross-tenant data into a tenant context.

::: warning Experimental
The API may change in a minor release until the satellite graduates to RC.
Requires **PostgreSQL 13+** (`DATE_TRUNC`).
:::

## Install

```bash
npm install @adonisjs-lasagna/reporting
node ace configure @adonisjs-lasagna/reporting
```

The configure hook registers the provider. There are no migrations — reporting
reads the existing `tenant_metrics` table (ensure the core metrics satellite is
enabled so that table is populated).

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

## Dashboard endpoint

Mount the read-only dashboard route with your own admin auth. The endpoint
exposes fleet-wide analytics, so it is **fail-closed**: `multitenancyReportingRoutes`
requires a `middleware`, and throws at startup if you omit it. Pass `middleware: false`
only to mount it public on purpose (behind a trusted network boundary).

```ts
// start/routes.ts
import { multitenancyReportingRoutes } from '@adonisjs-lasagna/reporting'
import { middleware } from '#start/kernel'

multitenancyReportingRoutes({
  prefix: '/admin/reporting',
  middleware: [middleware.auth(), middleware.role('owner')],
})
```

`GET /admin/reporting/dashboard?period=week&since=…&until=…&limit=20` returns
`{ data: { aggregate, topTenants } }`. Invalid `period` or non-ISO `since`/`until`
return `400`.

## Command

```bash
node ace tenant:report:generate --period=week --top=10
```

Prints the period aggregate and the top tenants — handy for an ops spot-check or
a scheduled summary.

## Read next

- [Metrics satellite](/docs/satellites/metrics) — the per-tenant counters this aggregates.
- [Compliance](/compliance) — per-tenant audit export (a different, single-tenant view).
