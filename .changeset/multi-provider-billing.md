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
