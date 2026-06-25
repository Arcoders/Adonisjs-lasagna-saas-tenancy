---
"@adonisjs-lasagna/saas-tenancy": patch
---

Fix `configure --with=metrics` so it publishes every table the metrics pipeline writes.
The bundle only published `create_tenant_metrics_table`, while the
`create_tenant_custom_metrics_table` and `create_tenant_metrics_monthly_table` stubs were
orphaned (in no bundle), even though the release notes already documented them as published
on new installs. A host that selected `metrics` and then emitted a custom metric via
`MetricsService.emitMetric` hit a missing `backoffice.tenant_custom_metrics` table on flush,
and `tenant:metrics:rollup` hit a missing `tenant_metrics_monthly` table. The `metrics`
bundle now publishes all three. Existing hosts re-run `configure @adonisjs-lasagna/saas-tenancy
--with=metrics` (idempotent, skips already-published migrations) then `migration:run
--connection=backoffice` to pick up the two new tables.
