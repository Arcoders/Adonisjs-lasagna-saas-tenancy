---
title: Metrics
description: Per-tenant time-series counters in Redis, flushed to the database for long-term aggregation.
---

# Metrics

Per-tenant counters useful for usage-based billing and operational
dashboards. Hot writes hit Redis; a daily flush rolls them into
`tenant_metrics` for long-term aggregation.

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=metrics
```

## Writing

```ts
import { MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'

const metrics = await app.container.make(MetricsService)

await metrics.increment(tenant.id, 'api.requests')
await metrics.increment(tenant.id, 'api.requests.errors', 5)
await metrics.gauge(tenant.id, 'storage.bytes', usedBytes)
```

Counters are aggregated per UTC day. Gauges store the latest value.

## Flushing

Hot writes accumulate in Redis under
`tenants/<id>/metrics/<day>/<key>`. The flush command rolls them
into the database:

```bash
# Cron: every night at 01:00 UTC
0 1 * * * node ace tenant:metrics:flush
```

```bash
# Backfill a specific day
node ace tenant:metrics:flush 2026-04-30
```

The flush uses a SCAN cursor; safe to run against arbitrarily large
key sets without the `KEYS` pattern's gotchas.

## Reading

```ts
const usage = await metrics.range(tenant.id, 'api.requests', {
  from: '2026-04-01',
  to: '2026-04-30',
})
// [{ day: '2026-04-01', value: 12345 }, …]
```

## Admin REST

```http
GET /admin/multitenancy/tenants/{id}/metrics?key=api.requests&from=2026-04-01&to=2026-04-30
```

## Caveats

- Counter increments do not write to the database; they hit Redis.
  If Redis is unavailable, increments are lost.
- The flush runs once per day. Until it runs, the database holds no
  rows for the current day; reads merge Redis + database
  transparently.
- Don't use this satellite for application-level metrics like
  request latency. Lasagna ships an OpenTelemetry integration.
  use the right tool.
