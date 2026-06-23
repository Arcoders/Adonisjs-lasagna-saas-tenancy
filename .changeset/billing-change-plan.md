---
"@adonisjs-lasagna/billing": minor
---

Add programmatic plan changes. `BillingService.changePlan(tenant, newPriceId)`
upgrades or downgrades a tenant's active subscription at the provider, behind a
new `subscription_update` capability (implemented for Stripe and Paddle; Lemon
Squeezy omits it and throws `unsupported_by_driver`). It validates the price
against `config.billing.products`, refuses deleted tenants, and initiates the
change with proration — the local mirror and plan reassignment reconcile from
the resulting `subscription.updated` webhook (`syncSubscription`).
