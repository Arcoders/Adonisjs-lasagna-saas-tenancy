---
"@adonisjs-lasagna/saas-tenancy": minor
"@adonisjs-lasagna/reporting": minor
---

Surface reporting data freshness (no Redis fallback).

Reports reflect flushed data only, so the dashboard now reports how current that is
rather than hiding the lag:

- **Reporting**: `ReportingService.getDataAsOf()` (latest flushed `period`, or null)
  and a `dataAsOf` field on the dashboard payload.
- **Core**: pure `mapDataAsOf`/`isStale`/`staleDays` helpers (`/services`) and an
  **opt-in** `metrics_freshness` doctor check that warns when `tenant:metrics:flush`
  has fallen behind. It is deliberately NOT in `builtInChecks` (a fresh/empty metrics
  table would warn forever) — register it where you run the metrics pipeline.

There is no Redis fallback by design: Redis holds only the partial, per-tenant
current period, and merging it would reintroduce cross-tenant fan-out.
