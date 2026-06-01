# Changelog

All notable changes to `@adonisjs-lasagna/saas-tenancy` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.2.2] — 2026-06-01

Feature and hardening release. Adds a dependency-resilience degradation
policy and a billing webhook replay fallback, closes several edge-case
failure modes found in a second audit, and activates the coverage gate.
No breaking changes: every new behavior is off by default or preserves the
prior contract. Now 555 unit + 358 integration + 123 e2e.

### Added

- **Dependency resilience policy**. `ResilienceService.run()` is one typed,
  observable contract for what happens when a backing dependency (Redis,
  Postgres, Stripe) is unavailable: `fail-open` returns a fallback,
  `fail-closed` throws `DependencyUnavailableException` (503 + `Retry-After`).
  Configure it per dependency under `config.resilience`, and every
  degradation can emit a `DependencyDegraded` event plus an OpenTelemetry
  span event for alerting. Adopted in `QuotaService` and
  `RateLimitMiddleware`.
- **Billing replay past Stripe's retrieval window**. When Stripe reports an
  event is gone (`resource_missing`), `BillingService.retrieveEvent()`
  reconstructs it from a PII-free, structurally-faithful copy the webhook
  controller persists in `stripe_processed_events.payload`
  (`toReplayablePayload`), so `tenant:billing:replay` works on events older
  than Stripe's ~30-day window.
- **Reference docs**. New Configuration, Exceptions, Troubleshooting, and
  Resilience pages on the docs site.

### Fixed

- **Circuit breaker state survives a restart**. Persisted OPEN state is now
  restored from Redis on process start, so a known-down tenant DB fails fast
  across a deploy instead of being probed back to life.
- **Unified Redis-outage handling in quotas**. `QuotaService.consume/track`
  route through the resilience policy, ending the silent `return 0` and the
  raw ioredis throw on a Redis outage.
- **Smaller correctness and hardening fixes**: `SchemaPgDriver` logs evicted
  connection-release failures instead of swallowing them;
  `assertSafeIdentifier` guards the backup/restore schema name; dead cache
  key removed from the feature-flag service; `SqlImportService` lazy-loads
  its logger so it is unit-testable; `reportUsage` idempotency-key JSDoc
  corrected.

### Changed

- **Coverage gate is live**. `check-coverage` is enforced on the unit run
  (`test:coverage`). The integration coverage run is report-only because it
  executes the compiled `build/` and c8 does not attribute that execution
  back to `src`.
- Test suite grew to 555 unit + 358 integration + 123 e2e.

---

## [0.2.1] — 2026-05-17

Hardening release. Three production-affecting bug fixes uncovered by
a test-coverage audit, plus a substantial integration + E2E expansion
(now 505 unit + 355 integration + 123 e2e).

### Fixed

- **Package queue jobs are now resolvable by `queue:work`**.
  `MultitenancyProvider.boot()` registers `InstallTenant`,
  `UninstallTenant`, `CloneTenant`, `BackupTenant`, `RestoreTenant`,
  `ProcessStripeEventJob`, `BillingCleanupJob`, and `ReportUsageBatchJob`
  with `@adonisjs/queue`'s `Locator`. Pre-fix, host apps' job
  auto-discovery (`app/jobs/**`) didn't reach into `node_modules`, so
  any dispatched package job was dead-lettered at the worker. Jobs are
  registered (and dispatched) under `lasagna.<JobName>` so a host
  app's same-named job can't collide.
- **`CloneService` integer-sequence reset now actually runs**.
  `#resetIntegerSequences` was passing `$1`/`$2` bindings to
  `trx.rawQuery()`; Knex rejects those (it expects `?`), but the
  failure was swallowed by the surrounding savepoint rollback.
  Result: every cloned tenant inherited its source's sequence, so the
  next insert PK-collided with a copied row. Identifiers are now
  interpolated directly into the SQL (guarded by
  `assertSafeIdentifier` upstream).
- **`ImpersonationMiddleware` constructor no longer breaks IoC
  resolution**. The optional typed constructor parameter forced the
  AdonisJS container to try injecting `ImpersonationService` at
  middleware resolution time, which it can't (the service needs a
  config-validated boot). Refactored to a `protected getService()`
  seam that subclasses can override for tests.

### Changed

- **Build artefact no longer embeds TypeScript source**.
  `inlineSources: true` removed from `tsconfig.json`. `.js.map` files
  in `build/` still reference `.ts` paths for stack traces but no
  longer carry the full source bytes — smaller install footprint for
  consumers.
- **Test coverage tooling**. Added `c8` with `test:coverage` /
  `test:integration:coverage` scripts and `.c8rc.json` (thresholds
  report-only at 0; ratchet after a baseline is captured). CI uploads
  `lcov.info` as an artifact.
- **CI provisions MinIO + mock-oauth2-server** so the new S3 / OIDC
  integration specs run against real backends. Optional
  `STRIPE_TEST_API_KEY` secret enables the Stripe live-API smoke
  test; without it the spec reports itself skipped.

### Test coverage

Closing the gap between "lots of tests" and "production confidence".
New end-to-end coverage for previously-thin paths:

- `examples/api/tests/e2e/commands_lifecycle.spec.ts` (10 tests) —
  real ace command execution for `tenant:list`/`suspend`/`activate`/
  `import`/`purge-expired`/`maintenance`/`impersonate`/`backups:run`/
  `webhooks:retry`.
- `examples/api/tests/e2e/queue_jobs.spec.ts` (2 tests) — real
  `queue:work` subprocess provisioning and tearing down tenants.
- `tests/integration/services/backup_s3.spec.ts` (real MinIO),
  `sso_oidc_real.spec.ts` (real `mock-oauth2-server`),
  `stripe_real_smoke.spec.ts` (real Stripe test API).
- `tests/integration/middleware/rate_limit.spec.ts` (6 tests, real
  Redis pipeline) and `impersonation_middleware.spec.ts` (real HTTP +
  Redis).
- `tests/integration/services/bootstrapper_isolation.spec.ts` (9
  tests, cross-tenant isolation + 16-way `AsyncLocalStorage`
  concurrency), `clone_service.spec.ts`, `doctor_checks_real.spec.ts`,
  `telemetry_export.spec.ts` (with real OTel SDK +
  `AsyncLocalStorageContextManager`).
- `tests/integration/billing/diagnostics_commands.spec.ts`
  (`tenant:billing:doctor` + `tenant:billing:test-webhook`).
- `tests/integration/billing/stripe_real_smoke.spec.ts` expanded to
  cover every Stripe SDK call-site.

### Upgrade notes

- **Drain your queue before upgrading** if you have unprocessed
  package jobs in Redis under the old names (`InstallTenant`,
  `UninstallTenant`, etc.). After upgrade, the worker resolves them
  under `lasagna.<JobName>`, so any pending pre-upgrade jobs will
  dead-letter at the worker.
- **Subclassers of `ImpersonationMiddleware`**: the constructor
  parameter is gone. Override `getService()` instead of injecting via
  `new ImpersonationMiddleware(service)`.

---

## [0.2.0] — 2026-05-09

Adds the **Stripe billing satellite** as the ninth opt-in feature.
Opt in with `node ace configure @adonisjs-lasagna/saas-tenancy --with=billing`
and `npm install stripe@^18`.

### Added

- **Billing satellite** — full Stripe integration:
  - Idempotent webhook receiver (`POST /webhooks/stripe`) with raw
    `INSERT ... ON CONFLICT (event_id) DO NOTHING`. HMAC-SHA256
    signature verification. Optional IP allowlist supporting both
    literal and CIDR entries via `node:net.BlockList` (zero deps).
  - Configurable dunning state machine (`maxAttempts`, `action`,
    `gracePeriodDays`) matching Stripe Smart Retries.
  - Metered billing — `BillingService.reportUsage()` plus the
    `usageMapping` auto-bridge that batches `QuotaTracked` events
    into a single `ReportUsageBatchJob` per `(tenant, meter)`.
  - Checkout (`createCheckoutSession`) and Billing Portal
    (`createBillingPortalSession`) helpers.
  - Tenant hard-delete policy (`onTenantDelete`: `cancel` / `detach`
    / `preserve`) wired via `HookRegistry.beforeDestroy`.
- **6 ace commands**: `tenant:billing:sync`, `tenant:billing:backfill`,
  `tenant:billing:replay`, `tenant:billing:cleanup`,
  `tenant:billing:doctor`, `tenant:billing:test-webhook`.
- **10 events**: `SubscriptionActivated`, `SubscriptionUpdated`,
  `SubscriptionCanceled`, `SubscriptionPaused`, `SubscriptionResumed`,
  `TrialEnding`, `PaymentSucceeded`, `PaymentFailed`,
  `BillingMisconfigured`, `BillingEventDeadLettered`.
- **3 jobs**: `ProcessStripeEventJob`, `ReportUsageBatchJob`,
  `BillingCleanupJob`.
- **4 satellite tables**: `stripe_customers`, `stripe_subscriptions`,
  `stripe_processed_events`, `stripe_meter_events`. Plus
  `tenant_plans` (shared with the quotas satellite).
- **Health check** `billingHealthCheck` (Stripe API ping + webhook
  freshness; `SLOW_API_THRESHOLD_MS` exported for test tuning).
- **Testing helpers** under `@adonisjs-lasagna/saas-tenancy/testing`:
  `MockStripe` (in-memory SDK double) and `signWebhookPayload`.
- **PII redaction**: `redactStripeEvent()` strip-list (whitelist) for
  webhook payloads and structured logs. `BillingEventDeadLettered`
  carries a stable `errorCode` enum, never raw `error.message`.
- **Documentation**: full reference at
  [Billing satellite](/docs/satellites/billing); end-to-end recipe
  at [Stripe + quotas (cookbook)](/docs/cookbook/stripe-quotas).

### Changed

- Total ace command count is now 33 (was 27).
- Total typed events is now 23 (13 tenant lifecycle + 10 billing).
- Total bundled jobs is now 8 (5 tenant + 3 billing).
- Boot guard: `BillingService.verify()` now **throws** when a
  `sk_live_*` key is loaded outside production without
  `STRIPE_ALLOW_LIVE_IN_DEV=true` (was warn-only). Same hard-fail in
  the other direction (`sk_test_*` + `NODE_ENV=production`).
- `multitenancy.stub` adds `/webhooks/stripe` to the default
  `ignorePaths`. Hosts that change `webhook.path` must update
  `ignorePaths` accordingly.

---

## [0.1.0] — 2026-05-07

Initial release of `@adonisjs-lasagna/saas-tenancy`.

This package continues the work previously published as
`@adonisjs-lasagna/multitenancy` v2.x. The rename reflects the
positioning of the package as the SaaS-tenancy foundation for
AdonisJS 7. The codebase is the same hardened core: pluggable
isolation drivers (schema-pg, database-pg, rowscope-pg, sqlite-memory),
13 typed lifecycle events, eight satellite features, contextual
logging, scheduled backups, read-replica routing, the `tenant:doctor`
diagnostic command, and an admin REST API.

### Highlights

- **Schema isolation** — every tenant gets its own `tenant_<uuid>`
  PostgreSQL schema, provisioned and routed automatically.
- **Pluggable isolation** — schema-per-tenant, database-per-tenant,
  shared-with-row-scope, or in-memory SQLite for tests.
- **Lifecycle hooks + 13 typed events** — declarative `before` /
  `after` hooks wired into commands and jobs.
- **Contextual logging** — `tenantId` rides through HTTP and queue
  jobs via `AsyncLocalStorage`.
- **`tenant:doctor`** — ten built-in checks, `--fix` for auto-recovery,
  `--json` for CI, `--watch` for a live TUI.
- **Plans & quotas** — declarative plans, atomic rolling counters,
  snapshot usage, `enforceQuota()` middleware that returns 429.
- **Scheduled backups + retention** — tier-based intervals, S3 mirror
  with purge awareness.
- **Health probes + Prometheus** — `/livez`, `/readyz`, `/healthz`,
  `/metrics`. No `prom-client` peer dep.
- **Read replica routing** — round-robin, random, or sticky-by-tenant-id.
- **REST admin API** — 36 endpoints + OpenAPI 3.1 spec + Swagger UI.
- **Soft delete TTL** — `--keep-schema` on destroy,
  `tenant:purge-expired` on a cron.
- **Eight satellites** — audit logs (append-only at SQL level),
  webhooks (HMAC-signed + retries), quotas, feature flags, branding,
  SSO/OIDC, metrics, impersonation. All optional.

### History

Pre-rename history (v1.x and v2.0.0-beta.x of
`@adonisjs-lasagna/multitenancy`) lives at the prior repository:
[github.com/Arcoders/Adonisjs-Lasagna-Multitenancy](https://github.com/Arcoders/Adonisjs-Lasagna-Multitenancy).
