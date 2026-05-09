---
title: Release notes
description: Auto-generated from CHANGELOG.md. The canonical changelog lives in the repo root.
---

# Release notes

> Auto-generated from
> [`CHANGELOG.md`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/CHANGELOG.md)
> at build time. The repo file is canonical.

All notable changes to `@adonisjs-lasagna/saas-tenancy` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

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
