import router from '@adonisjs/core/services/router'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import BillingWebhookController from './controllers/billing_webhook_controller.js'
import VerifyBillingWebhookMiddleware from './middleware/verify_billing_webhook_middleware.js'

export interface MultitenancyBillingRoutesOptions {
  /**
   * Webhook path. Defaults to `config.billing.webhook.path` or
   * `'/webhooks/stripe'`. MUST be in `config.ignorePaths` so TenantGuard
   * doesn't try to resolve a tenant for it (the job resolves the tenant from
   * the provider customer id once the event is decoded).
   */
  path?: string
}

/**
 * Mount the billing webhook receiver. Call from `start/routes.ts`:
 *
 * ```ts
 * import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
 * multitenancyBillingRoutes()
 * ```
 *
 * Wires the verification middleware (active-driver signature check) → the
 * controller, which stamps an idempotency row and dispatches the heavy work to
 * `ProcessBillingEventJob`.
 */
export function multitenancyBillingRoutes(options: MultitenancyBillingRoutesOptions = {}): void {
  const cfg = getConfig().billing
  const path = options.path ?? cfg?.webhook?.path ?? '/webhooks/stripe'

  const verify = new VerifyBillingWebhookMiddleware()
  router
    .post(path, (ctx) => new BillingWebhookController().handle(ctx))
    .use(async (ctx, next) => verify.handle(ctx, next))
    .as('billing.webhook')
}
