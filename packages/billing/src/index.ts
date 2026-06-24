// Service
export { default as BillingService } from './services/billing_service.js'
export type {
  CreateCheckoutOptions,
  CreatePortalOptions,
  ReportUsageOptions,
} from './services/billing_service.js'
export { redactBillingEvent } from './services/billing/redact.js'
export type { RedactedBillingEvent } from './services/billing/redact.js'

// Driver contract + neutral model (the public extension seam)
export type { BillingProviderContract } from './contracts/billing_provider_contract.js'
export type {
  BillingCapability,
  BillingDriverName,
  BillingEventType,
  BillingWebhookEvent,
  CheckoutCompleted,
  CheckoutOptions,
  Customer,
  CustomerRef,
  Invoice,
  PortalOptions,
  Price,
  Subscription,
  SubscriptionStatus,
  UsageOptions,
} from './contracts/types.js'
export { default as BillingDriverRegistry } from './services/billing/billing_driver_registry.js'
export { BILLING_CONTRACT_VERSION } from './constants.js'
// `getActiveBillingDriver` is the public accessor for the active driver. The
// `__*ForTests` cache/registry seams in the same module are intentionally NOT
// re-exported here — they're internal test hooks; import them from
// `./services/billing/active_billing_driver.js` directly inside the package.
export { getActiveBillingDriver } from './services/billing/active_billing_driver.js'

// Built-in drivers
export { default as StripeDriver } from './drivers/stripe/stripe_driver.js'
export { default as PaddleDriver } from './drivers/paddle/paddle_driver.js'
export { default as LemonSqueezyDriver } from './drivers/lemon_squeezy/lemon_squeezy_driver.js'

// Provider-agnostic satellite models
export { default as BillingCustomer } from './models/satellites/billing_customer.js'
export { default as BillingSubscription } from './models/satellites/billing_subscription.js'
export type { BillingSubscriptionStatus } from './models/satellites/billing_subscription.js'
export { default as BillingProcessedEvent } from './models/satellites/billing_processed_event.js'
export type { BillingProcessedEventStatus } from './models/satellites/billing_processed_event.js'
export { default as BillingUsageEvent } from './models/satellites/billing_usage_event.js'
export type { BillingUsageEventStatus } from './models/satellites/billing_usage_event.js'
export { default as BillingInvoiceSnapshot } from './models/satellites/billing_invoice_snapshot.js'

// Controllers (host-wired, behind your own auth + tenant middleware)
export { default as BillingInvoiceController } from './controllers/billing_invoice_controller.js'

// Exception
export { default as BillingException } from './exceptions/billing_exception.js'
export type { BillingErrorCode } from './exceptions/billing_exception.js'

// Middleware
export { default as VerifyBillingWebhookMiddleware } from './middleware/verify_billing_webhook_middleware.js'

// Jobs
export { default as ProcessBillingEventJob } from './jobs/process_billing_event_job.js'
export { default as BillingCleanupJob } from './jobs/billing_cleanup_job.js'
export { default as BillingSweepJob, runBillingSweep } from './jobs/billing_sweep_job.js'
export { default as ReportUsageBatchJob } from './jobs/report_usage_batch_job.js'

// Events
export { default as SubscriptionActivated } from './events/billing/subscription_activated.js'
export { default as SubscriptionUpdated } from './events/billing/subscription_updated.js'
export { default as SubscriptionCanceled } from './events/billing/subscription_canceled.js'
export { default as SubscriptionPaused } from './events/billing/subscription_paused.js'
export { default as SubscriptionResumed } from './events/billing/subscription_resumed.js'
export { default as TrialEnding } from './events/billing/trial_ending.js'
export { default as PaymentSucceeded } from './events/billing/payment_succeeded.js'
export { default as PaymentFailed } from './events/billing/payment_failed.js'
export { default as BillingMisconfigured } from './events/billing/billing_misconfigured.js'
export { default as BillingEventDeadLettered } from './events/billing/billing_event_dead_lettered.js'

// Webhook route registrar
export { multitenancyBillingRoutes } from './routes.js'
export type { MultitenancyBillingRoutesOptions } from './routes.js'

// Health check
export { billingHealthCheck } from './health/billing_health_check.js'

// Testing helpers
export { default as MockBillingDriver } from './testing/mock_billing_driver.js'
export { MockStripe } from './testing/mock_stripe.js'
export { signWebhookPayload } from './testing/sign_webhook_payload.js'
