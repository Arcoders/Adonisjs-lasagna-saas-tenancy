---
"@adonisjs-lasagna/billing": minor
---

Multi-provider billing: decouple the satellite from Stripe behind a driver contract.

Stripe is now one of several pluggable drivers. The package core no longer
imports any provider SDK statically — drivers lazy-load theirs — and a host
selects its provider with `config.billing.driver` (`'stripe' | 'paddle' |
'lemonsqueezy'`, plus custom drivers registered on `BillingDriverRegistry`).

This is the graduation milestone toward a 1.0-class API: `BillingProviderContract`
is now the stable public extension seam (mirrors `IsolationDriver`).

New:
- `BillingProviderContract` + neutral data model (`Customer`, `Subscription`,
  `Invoice`, `BillingWebhookEvent`, canonical event taxonomy).
- `BillingDriverRegistry` + `getActiveBillingDriver()` (container singleton,
  test hooks), wired from config in `BillingProvider.boot()`.
- Built-in drivers: `StripeDriver` (SDK), `PaddleDriver` and `LemonSqueezyDriver`
  (REST + native webhook HMAC verification), and an in-memory `MockBillingDriver`
  for tests. Capability introspection (`supports()`) so the service fails clearly
  (`unsupported_by_driver`) rather than faking a feature a provider lacks.

BREAKING:
- Tables renamed and neutralized (each gains a `provider` column):
  `stripe_customers` → `billing_customers`, `stripe_subscriptions` →
  `billing_subscriptions` (PK `stripe_subscription_id` → `provider_subscription_id`),
  `stripe_processed_events` → `billing_processed_events`, `stripe_meter_events` →
  `billing_usage_events`. Re-run `node ace configure @adonisjs-lasagna/saas-tenancy
  --with=billing` to publish the new migrations (or rename in place).
- Models renamed: `StripeCustomer/Subscription/ProcessedEvent/MeterEvent` →
  `BillingCustomer/Subscription/ProcessedEvent/UsageEvent`.
- Event payload field `stripeSubscriptionId` → `subscriptionId`.
- Exports renamed: `VerifyStripeWebhookMiddleware` →
  `VerifyBillingWebhookMiddleware`, `ProcessStripeEventJob` →
  `ProcessBillingEventJob`, `redactStripeEvent` → `redactBillingEvent`.
- `config.billing.stripe` is now optional (provide the block matching `driver`).

Hardening pass (same release):
- Dunning is now provider-independent: escalation runs on `max(provider attempt
  count, a counter persisted on the subscription)`, guarded against queue-retry
  double-counting, so `PaymentFailed{final:true}` and the `downgrade` action work
  even for Lemon Squeezy (which reports no attempt count). Reset on recovery.
- `dunning.gracePeriodDays` is now honoured (previously read but ignored): a
  non-zero grace schedules the downgrade and the new `tenant:billing:sweep`
  command applies it once the window elapses.
- Trial-ending parity: `tenant:billing:sweep` synthesises `TrialEnding` for
  Paddle / Lemon Squeezy (no native `trial_will_end` webhook), deduped against
  the native Stripe event via `trial_ending_notified_at`. New
  `config.billing.trialEndingLeadDays` (default 3).
- Immediate-cancel parity: new `subscription_cancel_immediate` capability and
  `BillingService.cancelSubscription(id, { atPeriodEnd })`. Lemon Squeezy (period
  -end only) is emulated by revoking access locally + reassigning `defaultPlan`.
- `ensureCustomer` race-safety for the REST drivers: Paddle sends an
  `Idempotency-Key`; Lemon Squeezy does find-or-create (lookup by email, reuse on
  a 422 conflict).
- Unknown provider subscription statuses fail closed (`incomplete` +
  `statusRecognized: false`) and never overwrite a known status, instead of
  silently mapping to `active`.
- New `billing_subscriptions` columns: `dunning_attempts`,
  `dunning_last_event_id`, `dunning_downgrade_at`, `trial_ending_notified_at`.
  Re-run configure (or `ALTER TABLE ... ADD COLUMN`) to pick them up.
- The internal `__*ForTests` active-driver hooks are no longer re-exported from
  the package root (import from the driver module if needed).
