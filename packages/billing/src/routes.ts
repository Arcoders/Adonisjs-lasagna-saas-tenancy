import router from '@adonisjs/core/services/router'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import StripeWebhookController from './controllers/stripe_webhook_controller.js'
import VerifyStripeWebhookMiddleware from './middleware/verify_stripe_webhook_middleware.js'

export interface MultitenancyBillingRoutesOptions {
  /**
   * Webhook path. Defaults to `config.billing.webhook.path` or
   * `'/webhooks/stripe'`. MUST be in `config.ignorePaths` so TenantGuard
   * doesn't try to resolve a tenant for it (the job resolves tenants from
   * the Stripe customer id once the event is decoded).
   */
  path?: string
}

/**
 * Mount the Stripe webhook receiver. Call from `start/routes.ts`:
 *
 * ```ts
 * import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
 * multitenancyBillingRoutes()
 * ```
 *
 * Wires verification middleware → controller. The controller stamps an
 * idempotency row and dispatches the heavy work to `ProcessStripeEventJob`.
 */
export function multitenancyBillingRoutes(options: MultitenancyBillingRoutesOptions = {}): void {
  const cfg = getConfig().billing
  const path = options.path ?? cfg?.webhook?.path ?? '/webhooks/stripe'

  // Wrap the class middleware as a function so the router invokes it with the
  // standard `(ctx, next)` signature (see the original note in core/health).
  const verify = new VerifyStripeWebhookMiddleware()
  router
    .post(path, (ctx) => new StripeWebhookController().handle(ctx))
    .use(async (ctx, next) => verify.handle(ctx, next))
    .as('billing.webhook')
}
