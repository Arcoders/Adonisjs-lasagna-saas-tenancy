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
cursor, so it is safe against arbitrarily large key sets (no `KEYS` pattern).

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

- Counter increments hit Redis, not the database. If Redis is unavailable,
  increments for that window are lost.
- The metric set is fixed (`requests`, `errors`, bandwidth). This satellite is for
  coarse per-tenant usage, not arbitrary named metrics or gauges.
- For application-level telemetry (latency, traces) use the OpenTelemetry
  integration instead. See [Health & metrics](/docs/health).
