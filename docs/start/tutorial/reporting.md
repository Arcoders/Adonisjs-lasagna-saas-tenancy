---
title: 'Tutorial 5: Reporting'
description: Turn Helpdesk activity into fleet-wide analytics — wire the metrics pipeline, emit a tickets_opened custom metric, aggregate it across all tenants, and mount a dashboard.
---

# Step 5: Reporting

The final step answers the questions per-tenant APIs can't: how much traffic across the
whole fleet this week, which customers are busiest, how many tickets everyone opened. You'll
wire the metrics pipeline, emit a Helpdesk-specific `tickets_opened` metric, and aggregate it
across every tenant from a single isolation-safe query.

Reporting aggregates the shared `backoffice` schema, so its queries **never enter a tenant's
`search_path`**. A built-in guard refuses to run inside `tenancy.run()`, which means a
reporting query can't leak one tenant's data into another's context by construction.

## 1. Install reporting

```bash
npm install @adonisjs-lasagna/reporting
node ace configure @adonisjs-lasagna/reporting
```

Reporting has no migrations of its own. It reads the `tenant_metrics` and
`tenant_custom_metrics` tables in the backoffice schema, which the core `metrics` bundle you
published in [step 1](/start/tutorial/setup#1-install-and-configure) created when you ran
`backoffice:setup`. If you skipped `--with=metrics` back then, add it now and re-run
`backoffice:setup` (it's idempotent) before continuing.

## 2. Wire the metrics pipeline

Two opt-in pieces feed the numbers. First, count every request by registering the
auto-metrics middleware:

```ts
// start/kernel.ts
router.use([
  () =>
    import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
      default: m.TrackMetricsMiddleware,
    })),
])
```

Register it the same lazy-import way you registered the tenant guard in
[step 1](/start/tutorial/setup#5-register-the-tenant-guard) so AdonisJS instantiates the
class and binds `this` for you. It records one request (and an error on a `>= 500` response,
plus the response bandwidth) against the resolved tenant. Recording is **fail-open**, so a
metrics hiccup never breaks a request. Second, schedule the flush that moves the buffered
Redis counters into the backoffice tables:

```bash
node ace tenant:metrics:flush   # run on a cron, e.g. every 5 minutes
```

Reports reflect **flushed** data only, there's no live Redis read by design, so the flush
cadence sets your freshness. The newest period a report can show is the last flush.

## 3. Emit a Helpdesk metric

The built-in counters are generic. To track something domain-specific, like tickets opened,
emit a **named** metric and reporting aggregates it the same isolation-safe way. Emit it
where a ticket is created, in the controller from [step 2](/start/tutorial/tenants):

```ts
// app/controllers/tickets_controller.ts
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'
import Ticket from '#models/ticket'
import type { HttpContext } from '@adonisjs/core/http'

export default class TicketsController {
  async store({ request }: HttpContext) {
    const tenant = await request.tenant()
    const ticket = await Ticket.create({ subject: request.input('subject'), status: 'open' })

    const metrics = new MetricsService()
    await metrics.emitMetric(tenant.id, 'tickets_opened', 1)

    return ticket
  }
}
```

Optionally declare the metric in config so reports get a label and a default aggregation.
It's metadata only, unregistered names still aggregate (default `SUM`):

```ts
// config/multitenancy.ts
import { defineReportingConfig } from '@adonisjs-lasagna/reporting'

export default defineConfig({
  // …core config…
  reporting: defineReportingConfig({
    metrics: [{ name: 'tickets_opened', aggregation: 'sum', description: 'Tickets opened' }],
  }),
})
```

`tenant:metrics:flush` writes both the built-in counters and your custom metric to the
backoffice tables.

## 4. Aggregate across the fleet

`ReportingService` answers fleet-wide questions. Call it from a backoffice context (a job, a
scheduled task, an admin endpoint), **never** inside `tenancy.run()`:

```ts
import app from '@adonisjs/core/services/app'
import { ReportingService } from '@adonisjs-lasagna/reporting'

const reporting = await app.container.make(ReportingService)

// Total tickets opened across every tenant.
const tickets = await reporting.getCustomAggregate({ name: 'tickets_opened', aggregation: 'sum' })

// Request totals and error rate per week, newest first.
const byWeek = await reporting.getAggregate({ period: 'week', since: '2026-06-01' })

// The busiest tenants over the window.
const top = await reporting.getTopTenants({ limit: 10 })
```

Metric names must be safe identifiers and the aggregation is whitelisted, so neither can
inject SQL.

## 5. Mount the dashboard

For a ready-made read-only dashboard, mount the reporting routes behind your own admin auth.
It's **fail-closed**: it refuses to mount without a `middleware`, so fleet-wide analytics
can't accidentally go public.

```ts
// start/routes.ts
import { multitenancyReportingRoutes } from '@adonisjs-lasagna/reporting'
import { middleware } from '#start/kernel'

multitenancyReportingRoutes({
  prefix: '/admin/reporting',
  middleware: [middleware.auth()],
})
```

`GET /admin/reporting/dashboard?period=week` returns the aggregate, the top tenants, your
custom-metric breakdown, and a `dataAsOf` freshness marker in one payload.

## You've built a SaaS

Helpdesk now does the full loop: it resolves a tenant per request, authenticates a user
inside that tenant's schema, enforces a paid plan's quota, stores data in the tenant's own
Postgres schema, and reports usage across the whole fleet without a single cross-tenant
leak. Everything from here is depth on the pieces you've already wired.

## Read next

- [Reporting](/guides/satellites/reporting); report extensions, the OpenAPI spec, and scaling the metrics table.
- [Production checklist](/reference/production-checklist); the hardening runbook before you ship.
- [Deployment](/guides/deployment); running the web app and the queue worker in production.
