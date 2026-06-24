---
title: Metrics
description: Per-tenant request/error/bandwidth counters in Redis, flushed to the database for long-term storage.
---

# Metrics

Per-tenant operational counters. The service tracks a fixed set of measures
(requests, errors, bandwidth) as hot Redis counters; a periodic flush rolls each
day's totals into `tenant_metrics` for long-term storage and reporting.

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=metrics
```

## Writing

```ts
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'

const metrics = await app.container.make(MetricsService)

await metrics.increment(tenant.id, 'requests')      // amount defaults to 1
await metrics.increment(tenant.id, 'errors', 1)
await metrics.trackBandwidth(tenant.id, bytesServed)
```

`increment` takes a fixed metric name, either `'requests'` or `'errors'`.
`trackBandwidth` accumulates a byte count. Both are per-UTC-day Redis counters
with a 48h TTL, keyed `metrics:<tenantId>:<period>:<metric>`.

## Flushing

The flush command rolls the Redis counters for a day into `tenant_metrics`:

```bash
# Cron: every night at 01:00 UTC
0 1 * * * node ace tenant:metrics:flush

# Backfill a specific day (period = yyyy-MM-dd)
node ace tenant:metrics:flush 2026-04-30
```

`MetricsService.flush(period?)` defaults to the current UTC day. It uses a SCAN
cursor, so it is safe against arbitrarily large key sets (no `KEYS` pattern). After
both flushes succeed the command emits a `MetricsFlushed` event (`/events`), which
the [reporting satellite](/docs/satellites/reporting) can subscribe to for
cache invalidation.

### Monthly rollup (high volume)

For very large fleets, `tenant:metrics:rollup` pre-aggregates the daily rows into a
per-tenant `tenant_metrics_monthly` table that reporting reads for whole-month
windows. It is idempotent and excludes the open month; run it after a month closes.
See [reporting → Scaling the metrics table](/docs/satellites/reporting).

### Partitioning

`tenant_metrics` is a plain table by default. At years-of-rows scale you can
RANGE-partition it by `period` without touching the package: the flush upsert's
`ON CONFLICT (tenant_id, period)` already includes the partition key `period`,
which Postgres requires (every unique/PK constraint on a partitioned table must
contain the partition column — so don't drop `period` from that constraint).

## Reading

```ts
// The most recent N days of persisted rows (default 30).
const rows = await metrics.getForTenant(tenant.id, 30)
// rows: TenantMetric[] with { period, requestCount, errorCount, bandwidthBytes }
```

`getForTenant` reads the flushed database rows. The current day's counters live in
Redis until the next flush, so they are not yet included in this result.

## Admin REST

```http
GET /admin/multitenancy/tenants/{id}/metrics?days=30
```

`days` is clamped to 1..365 (default 30) and the response returns the persisted
per-period rows.

## Caveats

- Counter increments hit Redis, not the database. `increment()` and
  `trackBandwidth()` `await` the Redis write directly and are **not** wrapped in
  the [resilience](/docs/resilience) policy (unlike `QuotaService`), so a Redis
  outage makes the call **reject** rather than silently drop it. Decide at your
  call site whether a metrics write is best-effort (catch and ignore) or should
  propagate.
- The metric set is fixed (`requests`, `errors`, bandwidth). This satellite is for
  coarse per-tenant usage, not arbitrary named metrics or gauges.
- For application-level telemetry (latency, traces) use the OpenTelemetry
  integration instead. See [Health & metrics](/docs/health).


## Read next

- [Health & monitoring](/docs/health); the Prometheus and probe surface.
- [Services API](/docs/services); the `MetricsService` methods.
- [Production checklist](/docs/production-checklist); the hardening runbook before you ship.
- [Satellites](/docs/satellites/); the rest of the opt-in features.
