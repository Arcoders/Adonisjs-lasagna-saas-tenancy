# Changelog

All notable changes to `@adonisjs-lasagna/billing` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-06-19

Graduated to `release candidate` and versioned `1.0.0` (see the stability matrix).
The API is considered final; `release candidate` (not `stable`) reflects the two
still-open items shared with the core, an independent security review and
production mileage.

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
- **Coverage floor raised** off the new unit baseline.

**Known limitation:** `tenant:billing:sync` reconciles Stripe only; Paddle / Lemon
Squeezy reconciliation is a documented fast-follow.

**Stability: release candidate.** The API is frozen under the 1.x promise, with the
honest caveat that a correction forced by the pending security review or production
mileage may land in a 1.x minor with a loud changelog entry.

## [0.1.0] — 2026-06-08

Initial standalone release, versioned `0.x` to match its `experimental` stability
label (see the stability matrix): the surface may change in any minor. The Stripe billing pipeline (shipped inside
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
