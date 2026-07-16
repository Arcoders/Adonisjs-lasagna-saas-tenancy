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
construction**. These queries never enter a tenant's `search_path`. A built-in
`assertNotInTenantScope()` guard refuses to run if called inside `tenancy.run()`,
so a reporting query can never leak cross-tenant data into a tenant context.

Requires **PostgreSQL 13+** (`DATE_TRUNC`).

## Install

```bash
npm install @adonisjs-lasagna/reporting
node ace configure @adonisjs-lasagna/reporting
```

The configure hook registers the provider. Reporting reads `tenant_metrics` (and,
for custom metrics, `tenant_custom_metrics`) in the backoffice schema. Run the
core migrations so those tables exist.

## The metrics pipeline (wire it once)

Reporting reads three real metrics (`request_count`, `error_count`,
`bandwidth_bytes`), but **the host owns emission**. Two opt-in pieces feed them:

1. Register the auto-metrics middleware so every request is counted:

   ```ts
   // start/kernel.ts — register globally, or apply per route group
   router.use([
     () =>
       import('@adonisjs-lasagna/saas-tenancy/middleware').then((m) => ({
         default: m.TrackMetricsMiddleware,
       })),
   ])
   ```

   Use the lazy-import form (the same shape as the other middleware) so AdonisJS
   instantiates the class and binds `this`; passing an unbound `.handle` would lose
   its instance context at runtime. To scope it to some routes instead, register it
   as a named middleware and apply `middleware.trackMetrics()` on a group. It records
   one request, an error on a `>= 500` response, and the response bandwidth against the
   resolved tenant. Recording is **fail-open**. A metrics backend hiccup never breaks
   a request.

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

// The freshest period present in the metrics tables (yyyy-MM-dd), or null when empty.
const asOf = await reporting.getDataAsOf()
```

`AggregationOptions`: `period` (`'day' | 'week' | 'month'`, default `day`),
`since`/`until` (ISO `YYYY-MM-DD`, default last 30 days), `limit` (top-N cap,
default 50, max 1000).

`getDataAsOf()` is a standalone `Promise<string | null>` you can call directly, the same
value the dashboard payload reports as `dataAsOf` (see [Data freshness](#data-freshness)),
handy for a freshness banner or a staleness gate outside the dashboard.

Call these from a backoffice context (a queue job, a scheduled task, or an admin
endpoint), never inside `tenancy.run()` (the guard throws).

## Custom metrics

Track your own domain metrics (bookings, revenue, jobs, …) the same isolation-safe
way the built-ins work: **emit a named metric**, and reporting aggregates it
cross-tenant from the backoffice schema. No per-tenant table fan-out, no raw SQL.

Emit wherever it makes sense in your app (values are integers, so use minor units
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

Optionally declare metadata (a label + default aggregation) in config. It's
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
is your responsibility. Use the `mapTenants` helper (below) so the fan-out is
bounded and error-isolated, and mind the connection budget (see
[Scaling limits](/guides/scaling-limits)). The built-in cross-tenant guard protects
only the built-in aggregations.
:::

### Fanning out across tenants — `mapTenants`

When an extension must read inside each tenant's schema, use `mapTenants` from
`@adonisjs-lasagna/saas-tenancy/services`. It runs your function inside each
tenant's `tenancy.run` scope with **bounded concurrency** (default 10, keep it
well under `maxTenantConnections`) and **error isolation**: one tenant failing is
collected into `errors`, not thrown, so a single bad tenant never aborts the
report.

```ts
import { mapTenants } from '@adonisjs-lasagna/saas-tenancy/services'

class SlowTenantsReport implements ReportExtension {
  readonly name = 'slow_tenants'
  readonly description = 'Per-tenant row counts across the busiest tenants'

  async execute(filters: ReportExtensionFilters) {
    const reporting = await app.container.make(ReportingService)
    const tenants = []
    for await (const { tenant } of reporting.iterateTenantsByUsage(filters)) {
      tenants.push(tenant)        // busiest-first, from the backoffice (no scope)
      if (tenants.length >= 50) break
    }
    // bounded, error-isolated fan-out into each tenant's schema
    const { results, errors } = await mapTenants(
      tenants,
      async (t) => SomeTenantModel.query().count('* as total'),
      { concurrency: 5 }
    )
    return { scanned: results.length, failed: errors.length, results }
  }
}
```

`mapTenants` accepts tenant **models** (not ids, `tenancy.run` needs the model);
if you only have ids, resolve them first with `resolveTenantRepository`. Pass
`{ continueOnError: false }` to fail fast on the first tenant error instead.

### Versioning your extension

The extension contract is versioned. Declare the version your report was written
against so the registry can reject an incompatible build at registration time
instead of failing at the first request:

```ts
import { REPORTING_CONTRACT_VERSION } from '@adonisjs-lasagna/reporting'

export class TopPropertiesReport implements ReportExtension {
  name = 'top_properties'
  description = 'Top 5 most-booked properties'
  contractVersion = REPORTING_CONTRACT_VERSION // 1
  async execute(filters, _options, signal) {
    /* … */
  }
}
```

`ReportExtensionRegistry.register()` compares `contractVersion` to the surface's
`REPORTING_CONTRACT_VERSION`. A version **newer** than this build fails fast (your
report relies on contract this version doesn't provide). A version **older**, or no
version at all, registers with a one-time warning so reports written before
versioning keep working. `GET {prefix}/reports/contract-version` returns the
version this deployment implements, so a host can check compatibility ahead of
time. This is the same warn/fail rule the satellite ABI uses, one level down. See
the [extensibility standard](/guides/extensibility) for how
`contractVersion` relates to `satelliteApi`.

### Execution guards: timeout and rate limit

Both are opt-in through `config.reporting.extensions` and apply to the HTTP route
and the CLI `--extension` flag. Without this block, extensions run unguarded.

```ts
// config/multitenancy.ts
reporting: defineReportingConfig({
  extensions: {
    timeoutMs: 30_000,
    rateLimit: { limit: 30, windowSeconds: 60 },
  },
})
```

`timeoutMs` is a **response deadline, not a kill switch**. `Promise.race` frees the
caller when the deadline passes, but it cannot stop work already running. So the
deadline also fires the `AbortSignal` passed to `execute(filters, options, signal)`:
thread it into your `fetch`/queries and a slow report unwinds instead of holding a
tenant connection past the deadline. A report that ignores the signal keeps running
in the background, so still mind the connection budget. A tripped deadline answers
`504`.

`rateLimit` is a Redis-backed sliding window keyed per `(extension, ip)` on the
route (per `(extension)` on the CLI). It needs Redis and follows the global
`resilience.redis.rateLimit` fail policy on an outage (fail-closed by default,
answering `503`). Exceeding the window answers `429`.

### Testing your extension

`@adonisjs-lasagna/reporting/testing` ships pure helpers (no booted app):

```ts
import { createTestExtension, registryWith } from '@adonisjs-lasagna/reporting/testing'

// a compatible extension that returns a fixed payload
const ext = createTestExtension({ name: 'demo', result: { rows: [] } })

// drive the version check: a newer contract makes register() throw
registryWith(createTestExtension({ contractVersion: REPORTING_CONTRACT_VERSION + 1 }))

// exercise the timeout guard
createTestExtension({ name: 'slow', delayMs: 5_000 })
```

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
`{ data: { aggregate, topTenants, customMetrics, dataAsOf } }`. Invalid `period`,
non-ISO `since`/`until`, or an over-wide/inverted window return `400`.

Caching is **global** (cross-tenant) by design, never tenant-scoped. It's a stale
window: within `cacheTtlMs`, a repeated query is served from cache. To keep the
view fresh, opt into event-driven invalidation. The dashboard cache is cleared the
moment `tenant:metrics:flush` lands:

```ts
// config/multitenancy.ts
reporting: {
  cache: { invalidateOnFlush: true },   // pair with cacheTtlMs on the routes
},
```

### Data freshness

Reports reflect **flushed** data only. The metrics pipeline buffers counters in
Redis and `tenant:metrics:flush` writes them to the backoffice tables; reporting
reads those tables, never Redis. So the newest data a report can show is the last
flushed period, surfaced as `dataAsOf` (the latest `period` present, or `null`
when empty) in the dashboard payload. There is **no Redis fallback** by design (it
would expose partial, per-tenant data and reintroduce cross-tenant fan-out). Run
the flush on a tight enough schedule for your freshness needs; the opt-in
`metrics_freshness` doctor check warns when it falls behind.

To reason about that `dataAsOf` value, the core ships three pure helpers on
`@adonisjs-lasagna/saas-tenancy/services` (no I/O, never throw):

```ts
import { mapDataAsOf, isStale, staleDays } from '@adonisjs-lasagna/saas-tenancy/services'

const asOf = mapDataAsOf(row)              // a MAX(period) row → 'yyyy-MM-dd' | null
isStale(asOf, '2026-06-25', 2)             // true when asOf is older than 2 days (null ⇒ stale)
staleDays(asOf, '2026-06-25')              // whole days behind, or null when asOf is absent
```

## OpenAPI spec

The reporting routes describe themselves as an OpenAPI 3.1 document, generated from the
service contract:

```ts
import { getReportingOpenAPISpec, listReportingSpecPaths } from '@adonisjs-lasagna/reporting'

const spec = getReportingOpenAPISpec('/reporting') // full document for the given route prefix
const paths = listReportingSpecPaths('/reporting') // just the path keys, for a router cross-check
```

`getReportingOpenAPISpec(prefix?)` returns the whole document (default prefix `/reporting`);
`listReportingSpecPaths(prefix?)` returns its path keys as a string array, handy in a test
that asserts every documented path is actually mounted. Pin the spec in CI to catch a
breaking change between versions.

## Command

```bash
node ace tenant:report:generate --period=week --top=10
node ace tenant:report:generate --format=csv --out=usage.csv
node ace tenant:report:generate --extension=top_properties
```

`--format` is `table` (default), `json`, or `csv`; `--out` writes to a file
instead of stdout; `--extension` runs a registered report extension.

## Scaling the metrics table

Built-in aggregation runs live over the daily `tenant_metrics` table, which is fine
into the thousands of tenants. For very large fleets (thousands of tenants × years
of rows) two opt-in levers keep it fast:

**Monthly rollup.** `tenant:metrics:rollup` collapses the daily rows into a
per-tenant `tenant_metrics_monthly` table (one row per tenant per month). With
`config.reporting.rollups.enabled`, `getAggregate({ period: 'month' })` and
`getTopTenants` serve **whole-month, fully-closed, covered** windows from that
~30×-smaller table; every other query (day/week, partial/open months, custom
metrics) transparently falls back to live aggregation. The rollup is idempotent
(re-running overwrites, never accumulates) and **never includes the open month**,
so a closed-window report is byte-identical whether served from the rollup or live.

```bash
# after the month closes — e.g. nightly or on the 1st
node ace tenant:metrics:rollup
```

**Partitioning.** Every reporting query filters `WHERE period BETWEEN … GROUP BY`
the period bucket, which is partition-pruning friendly. RANGE-partition
`tenant_metrics` (and `tenant_custom_metrics`) by `period` so the planner only
scans the partitions a window touches. This is host-managed (the package ships a
plain table); the existing `UNIQUE(tenant_id, period)` already includes the
partition key, which Postgres requires. Don't reorder it. See
[Scaling limits](/guides/scaling-limits).

## Prepared for future iterations

Not built yet, but on the roadmap: configurable dashboard panels (a backend
contract + a `reporting-ui` satellite) and a metrics-management CLI
(`tenant:reporting:metrics:list`).

## Read next

- [Metrics satellite](/guides/satellites/metrics) — the per-tenant counters this aggregates.
- [Resilience](/guides/resilience) — reporting's failure modes and recovery.
- [Compliance](/guides/compliance) — per-tenant audit export (a different, single-tenant view).
