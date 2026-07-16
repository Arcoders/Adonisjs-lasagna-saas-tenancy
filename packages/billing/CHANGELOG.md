# Changelog

All notable changes to `@adonisjs-lasagna/billing` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.1.0] — 2026-07-10

Shipped as `experimental` at `0.1.0` (see the stability matrix). The API carries no
semver promise and may change in any minor. Two items are still open, shared with
the core: an independent security review and production mileage. The Stripe billing
pipeline (shipped inside `@adonisjs-lasagna/saas-tenancy` since 0.2.0) was extracted
into its own package so a CVE in the Stripe SDK no longer forces a core bump and so
billing versions independently. It depends on the core as a peer (`>=0.3.0 <1.0.0`);
`stripe` is an optional peer dependency.

### Breaking changes

- **Billing is now provider-neutral, not Stripe-only.** Stripe is one of several
  pluggable drivers behind `BillingProviderContract`; the package core no longer
  imports any provider SDK statically (drivers lazy-load theirs). Select a provider
  with `config.billing.driver` (`'stripe' | 'paddle' | 'lemonsqueezy'`, plus custom
  drivers on `BillingDriverRegistry`). **Migration:** tables are renamed and gain a
  `provider` column (`stripe_customers` → `billing_customers`, `stripe_subscriptions`
  → `billing_subscriptions` with PK `stripe_subscription_id` →
  `provider_subscription_id`, `stripe_processed_events` → `billing_processed_events`,
  `stripe_meter_events` → `billing_usage_events`). Re-run `node ace configure
  @adonisjs-lasagna/billing` and run migrations (or rename in place). Models renamed:
  `StripeCustomer/Subscription/ProcessedEvent/MeterEvent` →
  `BillingCustomer/Subscription/ProcessedEvent/UsageEvent`. Exports renamed:
  `VerifyStripeWebhookMiddleware` → `VerifyBillingWebhookMiddleware`,
  `ProcessStripeEventJob` → `ProcessBillingEventJob`, `redactStripeEvent` →
  `redactBillingEvent`. The event payload field `stripeSubscriptionId` is now
  `subscriptionId`. `config.billing.stripe` is now optional: provide the config
  block matching your `driver`. The internal `__*ForTests` active-driver hooks are
  no longer re-exported from the package root; import them from the driver module.
- **Usage-event uniqueness is now per tenant (migration).** `billing_usage_events`
  previously had a GLOBAL `UNIQUE(idempotency_key)`. A host that supplied its own
  (non-tenant-prefixed) `idempotencyKey` could then have one tenant's usage report
  collide with a different tenant's row and silently drop the second billable
  event. The constraint is now `UNIQUE(tenant_id, idempotency_key)` and the
  idempotency lookup filters by tenant. **Migration:** re-run the satellite
  configure (`node ace configure @adonisjs-lasagna/billing`) and run migrations to
  apply `fix_billing_usage_events_unique_per_tenant`, which drops the global
  constraint and adds the composite. It is idempotent and order-independent. If
  two pre-existing rows across different tenants already share an
  `idempotency_key`, the migration fails loudly: de-duplicate them first.

### Added

- **Owns its config types + `config.billing` block.** `BillingConfig` and
  `BillingDriverChoice` now live here (moved out of core), and the `billing` block
  is contributed onto `MultitenancyConfig` via core's open `SatelliteConfigRegistry`
  (declaration merging) — so core's frozen public type no longer hard-codes
  billing's shape, and `getConfig().billing` is typed wherever this package is
  imported. Authoring `config.billing` is unchanged; import `BillingConfig` from
  `@adonisjs-lasagna/billing` (not `@adonisjs-lasagna/saas-tenancy/types`).
- **Pluggable billing drivers.** `BillingProviderContract` plus a neutral data model
  (`Customer`, `Subscription`, `Invoice`, `BillingWebhookEvent`, canonical event
  taxonomy), `BillingDriverRegistry` + `getActiveBillingDriver()` (container
  singleton, test hooks, wired from config in `BillingProvider.boot()`), and built-in
  drivers `StripeDriver`, `PaddleDriver` and `LemonSqueezyDriver` (REST + native
  webhook HMAC verification) plus an in-memory `MockBillingDriver` for tests.
  Capability introspection (`supports()`) makes the service fail clearly
  (`unsupported_by_driver`) rather than faking a feature a provider lacks.
  `BillingProviderContract` is the stable public extension seam (mirrors
  `IsolationDriver`).
- **Programmatic plan changes.** `BillingService.changePlan(tenant, newPriceId)`
  upgrades or downgrades a tenant's active subscription at the provider, behind a new
  `subscription_update` capability (Stripe and Paddle; Lemon Squeezy throws
  `unsupported_by_driver`). It validates the price against `config.billing.products`,
  refuses deleted tenants, and initiates the change with proration. The local mirror
  and plan reassignment reconcile from the resulting `subscription.updated` webhook.
- **Opt-in auto-suspend on payment failure.** When
  `config.billing.suspendOnPaymentFailure` is true, a tenant is suspended (status →
  `suspended`, dispatching `TenantSuspended`) on `PaymentFailed{final:true}` or
  `SubscriptionCanceled{reason:'dunning_failed'}`; `user_canceled` and non-final
  dunning retries are ignored. With `reactivateOnPaymentSuccess` also true, a later
  `PaymentSucceeded` reactivates the tenant. Both transitions are idempotent.
- **Provider-independent dunning and parity sweeps.** Dunning escalation runs on
  `max(provider attempt count, a counter persisted on the subscription)`, guarded
  against queue-retry double-counting, so the final-failure and downgrade paths work
  even for Lemon Squeezy (which reports no attempt count). `dunning.gracePeriodDays`
  is now honoured (previously read but ignored): a non-zero grace schedules the
  downgrade, applied once the window elapses by the new `tenant:billing:sweep`
  command, which also synthesises `TrialEnding` for Paddle / Lemon Squeezy (no native
  `trial_will_end` webhook, deduped against the native Stripe event) under the new
  `config.billing.trialEndingLeadDays` (default 3). New `billing_subscriptions`
  columns `dunning_attempts`, `dunning_last_event_id`, `dunning_downgrade_at`,
  `trial_ending_notified_at` (re-run configure to pick them up).
- **Immediate cancellation.** New `subscription_cancel_immediate` capability and
  `BillingService.cancelSubscription(id, { atPeriodEnd })`. Lemon Squeezy (period-end
  only) is emulated by revoking access locally and reassigning `defaultPlan`.
- **Opt-in fiscal features (Track B).** Multi-country tax snapshots plus an
  append-only invoice read model; the provider stays the source of truth (no local
  invoice numbering, no tax engine). The fiscal DDL ships as separate stubs in
  `stubs/migrations-fiscal/` and is published only when you opt in (answer yes to the
  configure prompt, default no, or set `LASAGNA_BILLING_FISCAL=1`); runtime behaviour
  is gated by `config.billing.fiscal.enabled`. Adds `country_code` to
  `billing_customers`; the neutral `Invoice` and `PaymentSucceeded` now carry optional
  `subtotal` / `tax` / `total` (integer minor units) mapped from each provider; Stripe
  checkout passes `automatic_tax` when `config.billing.fiscal.automaticTax` is set; a
  new append-only `billing_invoice_snapshots` table is written on
  `invoice.payment_succeeded` (idempotent via `UNIQUE (provider, provider_invoice_id)`).
  A new exported `BillingInvoiceController` (`index` + `pdf`) the host mounts behind
  its own auth and tenant middleware lists the tenant's snapshots and redirects to the
  provider-hosted PDF; the package never auto-registers unauthenticated tenant-data
  routes.
- **DLQ inspection.** New read-only `tenant:billing:dlq:list` (`--json`, `--limit`)
  over the `status='failed'` ledger rows, pairing with `tenant:billing:replay`. A
  runnable demo listener escalates payment-related dead-letters.
- **Pricing validation.** New CI-friendly `tenant:billing:pricing:validate` (`--json`,
  exit 1 on a real misconfiguration; provider price resolution is warn-only and
  degrades for drivers without `price_lookup`).

### Security

- **Currency-consistency guard.** `createCheckoutSession` accepts an optional
  `currency` and rejects a mismatch with the customer's established currency up front
  (`currency_mismatch`) instead of surfacing a provider-specific error later.
- **Late/replayed events can't resurrect a deleted tenant.** `syncSubscription`
  no-ops for a `deleted` tenant whose customer mirror survives a soft status flip, so
  a stale or replayed event can't restore a plan or quota. Fail-open if the repository
  is unavailable.
- **Unknown provider subscription statuses fail closed** (`incomplete` +
  `statusRecognized: false`) and never overwrite a known status, instead of silently
  mapping to `active`.

### Changed

- **`@adonisjs/queue` peer widened to `>=0.6.0 <1`** (was a capped `^0.6.0`). It
  stays a required peer: the package dispatches background jobs from its main
  barrel (webhook processing via `ProcessBillingEventJob`, usage batching), so a
  queue worker is part of the supported setup.
- **Multi-provider reconciliation parity.** `tenant:billing:sync` is now
  driver-neutral: a capability-gated `subscription_list` (Stripe, Paddle, Lemon
  Squeezy) drives the forward pass for every provider. A driver without the capability
  skips the forward pass with an explicit warning; the reverse pass still runs.
  `tenant:billing:doctor` reports per-provider reconciliation coverage.
- **Billing owns its migrations.** Migrations previously published from core now ship
  with this package. Existing apps are unaffected (their migrations are already
  committed), but `--with=billing` now requires the package to be installed; the
  canonical install is `node ace configure @adonisjs-lasagna/billing`.
- **`ensureCustomer` race-safety for the REST drivers.** Paddle sends an
  `Idempotency-Key`; Lemon Squeezy does find-or-create (lookup by email, reuse on a
  422 conflict).
- **Coverage floor raised** off the new unit baseline.

### Fixed

- **`configure @adonisjs-lasagna/billing` no longer publishes an ALTER before the
  CREATE it depends on.** The satellite's stubs are published in sorted order, and
  `add_processing_status_to_billing_processed_events` sorts ahead of
  `create_billing_processed_events_table`. On a clean install `migration:run` therefore
  tried to `ALTER TABLE backoffice.billing_processed_events` before that table existed,
  and aborted. Only new installs were affected: the four-value status enum the ALTER
  adds is already present in the create migration. The stubs are now numbered `0001_`
  through `0006_`, which is the publish order. The ordinal is stripped before the
  migration reaches the host, so an install that already ran these migrations does not
  republish them.
- **Type resolution for the `/provider` and `/commands` subpath exports.** These
  subpaths were declared in `exports` but had no matching `typesVersions` entries, so
  a consumer on `node10`-style module resolution could not resolve their type
  declarations (surfaced by `arethetypeswrong`). Added `typesVersions` mirroring the
  core package.
- **README refreshed for this release.** Badge corrected to experimental;
  configure-first install documented; added a Configuration section (driver block,
  `products`/`defaultPlan`, and the webhook `ignorePaths` requirement).
- **Quota-exceeded notification now fails open on a Redis outage.** The advisory
  per-(tenant, quota) dedupe behind `notifyOnQuotaExceeded` now wraps its Redis
  `SETNX`: a runtime Redis error logs and sends without dedupe instead of throwing
  out of the listener (`lazyRedis()` only caught the peer-absent import, not a live
  outage). A possible duplicate email beats a dropped warning, matching the
  package's fail-open convention for advisory Redis paths. Covered by new
  fail-open / dedupe / degraded tests; the fragile real Stripe Test Clock smoke now
  also soft-skips Stripe-side infra failures while still blocking on genuine
  renewal/dunning regressions (the skip-vs-fail classifier is unit-tested).

### Added

- `BillingService`: checkout sessions, billing-portal sessions, metered-usage reporting, and
  the configurable dunning state machine. Replay past Stripe's retrieval window via a PII-free,
  structurally-faithful copy persisted by the webhook controller.
- Idempotent webhook receiver plus `VerifyStripeWebhookMiddleware`: HMAC-SHA256 signature
  verification and an optional IP allowlist (literal and CIDR entries via `node:net.BlockList`).
- `redactStripeEvent`: whitelist PII redaction for webhook payloads and structured logs.
- Stripe satellite models: `StripeCustomer`, `StripeSubscription`, `StripeProcessedEvent`,
  `StripeMeterEvent`.
- 10 billing events (`SubscriptionActivated`/`Updated`/`Canceled`/`Paused`/`Resumed`,
  `TrialEnding`, `PaymentSucceeded`/`Failed`, `BillingMisconfigured`,
  `BillingEventDeadLettered`) and 3 jobs (`ProcessStripeEventJob`, `ReportUsageBatchJob`,
  `BillingCleanupJob`).
- `multitenancyBillingRoutes` registrar, `billingHealthCheck`, and the `tenant:billing:*` ace
  commands.
- `BillingException` with a stable `BillingErrorCode` enum.
- Testing helpers: `MockStripe` (in-memory SDK double) and `signWebhookPayload`.

### Migration from core 0.2.x

`BillingService`, the Stripe models, the billing events/jobs, `BillingException`,
`VerifyStripeWebhookMiddleware`, `multitenancyBillingRoutes`, `billingHealthCheck`,
`MockStripe`, and `signWebhookPayload` moved here. Update imports to `@adonisjs-lasagna/billing`
and register `@adonisjs-lasagna/billing/provider` and `@adonisjs-lasagna/billing/commands` in
`adonisrc.ts`. The Stripe config types stay in `@adonisjs-lasagna/saas-tenancy/types`.

**Stability: experimental.** The API carries no semver promise and may change in any
minor, with the honest caveat that a correction forced by the pending security review
or production mileage lands with a loud changelog entry. See the
[stability matrix](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/reference/stability.md).
