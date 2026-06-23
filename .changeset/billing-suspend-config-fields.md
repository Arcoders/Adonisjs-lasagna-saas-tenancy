---
"@adonisjs-lasagna/saas-tenancy": minor
---

Add two opt-in `BillingConfig` flags (default `false`):
`suspendOnPaymentFailure` and `reactivateOnPaymentSuccess`. They live in the core
config type (the billing satellite reads them) and drive the new auto-suspend /
reactivate listeners shipped in `@adonisjs-lasagna/billing`.
