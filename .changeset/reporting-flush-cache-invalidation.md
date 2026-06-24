---
"@adonisjs-lasagna/saas-tenancy": minor
"@adonisjs-lasagna/reporting": minor
---

Refresh the reporting dashboard cache the moment metrics are flushed.

- **Core**: a new `MetricsFlushed` event (`/events`), dispatched by
  `tenant:metrics:flush` after both the built-in and custom flushes succeed
  (best-effort — a throwing listener never fails the command). It is fired from the
  command, not `MetricsService.flush`, so it neither double-fires nor fires on
  standalone library use.
- **Reporting**: with `config.reporting.cache.invalidateOnFlush`, the provider
  subscribes and clears the global `reporting` cache namespace on each flush, so a
  cached dashboard (`cacheTtlMs > 0`) goes fresh as soon as new data lands. Off by
  default; the whole namespace is cleared (a flush touches the rolling-window key
  space, so surgical per-key deletion can't cover it).
