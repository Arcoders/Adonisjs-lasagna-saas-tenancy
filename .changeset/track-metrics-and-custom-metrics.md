---
"@adonisjs-lasagna/saas-tenancy": minor
---

Add the request-metrics data pipeline and a custom named-metrics API.

- **`TrackMetricsMiddleware`** (`/middleware`): an opt-in middleware that records
  one request, an error on a `>= errorThreshold` (default 500) response, and the
  response bandwidth (from `Content-Length`) against the resolved tenant — feeding
  the `tenant_metrics` table the `reporting` satellite reads. Recording is
  fail-open (a metrics backend error never breaks the request; the downstream
  handler's own error always propagates) and bypasses `app.inTest` by default.
- **`MetricsService.emitMetric(tenantId, name, value)`** + **`flushCustomMetrics()`**:
  record host-defined named metrics (e.g. `rental_bookings`, `revenue_cents`)
  through the same Redis → backoffice pipeline as the built-in counters. Values are
  integers (minor units); names are validated as safe identifiers. They flush to
  the new `backoffice.tenant_custom_metrics` table (`tenant:metrics:flush` now runs
  both flushes), and `emitMetric` dispatches a `MetricRecorded` event (`/events`).
- A `create_tenant_custom_metrics_table` migration stub is added; new installs run
  it. Existing installs that adopt custom metrics apply the same DDL.

All additive and opt-in — no behavior change for apps that don't register the
middleware or call `emitMetric`.
