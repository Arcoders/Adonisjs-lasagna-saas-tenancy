# @adonisjs-lasagna/reporting

Cross-tenant analytics & reporting for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy):
aggregated usage metrics, top-N tenant rankings, and period summaries over the
backoffice schema.

[![Stability: release candidate](https://img.shields.io/badge/stability-release_candidate-C26A4B)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Stability: release candidate.** The API is frozen under the 1.x promise, with the honest caveat that a correction forced by the pending security review or production mileage may land in a 1.x minor with a loud changelog entry. Pin the version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

It was split out of the core so the analytics surface versions on its own cadence
and is only installed by apps that report. It reads the core's existing metrics
tables (`tenant_metrics`, `tenant_custom_metrics`) — it owns no tables of its own.

## Install

```bash
npm i @adonisjs-lasagna/reporting @adonisjs-lasagna/saas-tenancy
node ace configure @adonisjs-lasagna/reporting
```

`@adonisjs-lasagna/saas-tenancy` (the core) is a required peer, along with
`@adonisjs/core`, `@adonisjs/lucid`, and `luxon` (already present in a typical
Adonis + Lucid app). `node ace configure` registers the provider in `adonisrc.ts`.
**There is no `migration:run` step** — reporting publishes no migrations; it
aggregates the core `tenant_metrics` table.

## Wire it up

Mount the dashboard from `start/routes.ts`. The endpoints expose fleet-wide,
cross-tenant analytics, so the mount is **fail-closed**: it throws at startup
unless you pass `middleware` (or `middleware: false` to mount public on purpose,
behind a trusted network boundary).

```ts
// start/routes.ts
import { multitenancyReportingRoutes } from '@adonisjs-lasagna/reporting'
import { middleware } from '#start/kernel'

multitenancyReportingRoutes({ middleware: middleware.adminAuth() })
```

`multitenancyReportingRoutes(options)` accepts:

| Option | Default | Notes |
|---|---|---|
| `prefix` | `/reporting` | Mount prefix. |
| `middleware` | — | **Required** (or `false`). Auth applied to every route. |
| `cacheTtlMs` | off | Cache dashboard responses in the global `reporting` namespace; never tenant-scoped. |
| `maxRangeDays` | `366` | Max `since→until` span; over-wide/inverted ranges return `400`. |
| `openapi` | off | Also mount `{prefix}/openapi.json` + `{prefix}/docs` (Swagger UI) under the same auth. |

Endpoints (relative to `prefix`): `GET /dashboard`, `GET /reports/extension/:name`,
`GET /reports/contract-version`.

## Usage

Resolve `ReportingService` from the container (it is a singleton — never `new` it):

```ts
import { ReportingService } from '@adonisjs-lasagna/reporting'

const reporting = await app.container.make(ReportingService)

const totals = await reporting.getAggregate({ period: 'month' }) // totals + error rate per bucket
const top = await reporting.getTopTenants({ limit: 10 })         // top-N tenants by volume
const asOf = await reporting.getDataAsOf()                       // freshness: MAX(period) or null
```

Full surface: `getAggregate`, `getTopTenants`, `iterateTenantsByUsage` (async
iterable), `getCustomAggregate`, `getCustomMetricsBreakdown`, `getDataAsOf`. Every
method asserts it is **not** running inside a tenant scope — reporting is always
cross-tenant.

## Custom metrics & report extensions

Record custom counters from your app via the core `MetricsService.emitMetric(tenantId,
name, value)`; they land in `tenant_custom_metrics` and surface through
`getCustomAggregate` / `getCustomMetricsBreakdown`. See the
[metrics guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/metrics).

Register your own report through `ReportExtensionRegistry` from your provider's
`boot()`:

```ts
import { ReportExtensionRegistry, REPORTING_CONTRACT_VERSION } from '@adonisjs-lasagna/reporting'

const registry = await app.container.make(ReportExtensionRegistry)
registry.register(myReport) // implements ReportExtension { name, description, contractVersion?, execute() }
```

`REPORTING_CONTRACT_VERSION` is the report-extension surface version (independent of
the satellite ABI). An extension may pin its expected `contractVersion`.

## Commands

| Command | What it does | Key flags |
|---|---|---|
| `tenant:report:generate` | Generate and print a cross-tenant usage report | `--period` (day\|week\|month), `--since`, `--until`, `--top`, `--format` (table\|json\|csv), `--out`, `--extension` |

## Full documentation

<https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/reporting>
