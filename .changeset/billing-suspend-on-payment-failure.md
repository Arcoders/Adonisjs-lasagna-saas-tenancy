---
"@adonisjs-lasagna/billing": minor
---

Add opt-in auto-suspend on payment failure. When
`config.billing.suspendOnPaymentFailure` is true, a tenant is suspended (status →
`suspended`, dispatching `TenantSuspended`) on `PaymentFailed{final:true}` or
`SubscriptionCanceled{reason:'dunning_failed'}`; `user_canceled` and non-final
dunning retries are ignored. With `reactivateOnPaymentSuccess` also true, a later
`PaymentSucceeded` reactivates the tenant. Both transitions are idempotent.
Auto-upgrade stays a documented host recipe (consent/legal), driven by
`BillingService.changePlan`.
