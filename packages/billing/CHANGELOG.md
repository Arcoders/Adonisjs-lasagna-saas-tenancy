# Changelog

All notable changes to `@adonisjs-lasagna/billing` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-06-08

Initial standalone release. The Stripe billing pipeline (shipped inside
`@adonisjs-lasagna/saas-tenancy` since 0.2.0) was extracted into its own package so a CVE in
the Stripe SDK no longer forces a core bump and so billing versions independently. It depends
on the core as a peer (`^1.0.0`); `stripe` is an optional peer dependency.

**Stability: experimental.** The API is covered by tests but may change in a minor release.
Pin the version and read this changelog before upgrading. See the
[stability matrix](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/docs/stability.md).

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
