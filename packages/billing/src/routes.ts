import router from '@adonisjs/core/services/router'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import BillingWebhookController from './controllers/billing_webhook_controller.js'
import VerifyBillingWebhookMiddleware from './middleware/verify_billing_webhook_middleware.js'
import { resolveBillingWebhookPath } from './webhook_path.js'

export interface MultitenancyBillingRoutesOptions {
  /**
   * Webhook path. Defaults to `config.billing.webhook.path` or
   * `'/webhooks/billing'` (provider-neutral — billing supports Stripe, Paddle,
   * and Lemon Squeezy). MUST be in `config.ignorePaths` so TenantGuard doesn't
   * try to resolve a tenant for it (the job resolves the tenant from the
   * provider customer id once the event is decoded).
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
 *
 * NOTE: when `config.billing.webhook.enforceIpAllowlist` is on, the allowlist
 * check uses `request.ip()`. Behind a proxy/load balancer you MUST configure
 * AdonisJS `http.trustProxy` so `request.ip()` resolves the real client IP from
 * `X-Forwarded-For` — otherwise every request looks like it comes from the proxy
 * and the allowlist either blocks everything or trusts a spoofable header.
 * Signature verification is the primary control; the allowlist is defence in
 * depth.
 */
export function multitenancyBillingRoutes(options: MultitenancyBillingRoutesOptions = {}): void {
  const cfg = getConfig().billing
  const path = resolveBillingWebhookPath(options, cfg)

  const verify = new VerifyBillingWebhookMiddleware()
  router
    .post(path, (ctx) => new BillingWebhookController().handle(ctx))
    .use(async (ctx, next) => verify.handle(ctx, next))
    .as('billing.webhook')
}
