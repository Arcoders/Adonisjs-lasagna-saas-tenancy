---
"@adonisjs-lasagna/saas-tenancy": minor
"@adonisjs-lasagna/reporting": minor
---

Add an optional per-tenant monthly rollup for fast reporting at high volume.

- **Core**: a new `backoffice.tenant_metrics_monthly` table (one row per tenant per
  month), a `tenant:metrics:rollup` command, and `MetricsService.recomputeMonthlyRollup()`
  that collapses the daily `tenant_metrics` rows into it. The recompute is idempotent
  (overwrites, never accumulates) and excludes the still-open month by default.
- **Reporting**: with `config.reporting.rollups.enabled`, `getAggregate({ period: 'month' })`
  and `getTopTenants` serve **whole-month, fully-closed, covered** windows from the
  ~30×-smaller rollup table; every other query (day/week, partial/open months, custom
  metrics) transparently falls back to live aggregation. A closed-window report is
  byte-identical whether served from the rollup or live.

Opt-in and additive. New installs run the `create_tenant_metrics_monthly_table`
migration; existing installs that adopt the rollup apply the same DDL.
