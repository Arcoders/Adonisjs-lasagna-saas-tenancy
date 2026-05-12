import router from '@adonisjs/core/services/router'
import HealthController from './health_controller.js'
import StripeWebhookController from '../controllers/stripe_webhook_controller.js'
import VerifyStripeWebhookMiddleware from '../middleware/verify_stripe_webhook_middleware.js'
import { getConfig } from '../config.js'

export interface MultitenancyRoutesOptions {
  /** URL prefix for all mounted endpoints. Defaults to no prefix (root paths). */
  prefix?: string
  /** Mount /healthz, /livez, /readyz endpoints. Default true. */
  health?: boolean
  /** Mount /metrics (Prometheus text-exposition) endpoint. Default true. */
  metrics?: boolean
}

/**
 * Mount the package's operational endpoints. Call from `start/routes.ts`:
 *
 * ```ts
 * import { multitenancyRoutes } from '@adonisjs-lasagna/saas-tenancy/health'
 * multitenancyRoutes()
 * ```
 *
 * All routes are opt-in — nothing is registered unless this helper is called.
 */
export function multitenancyRoutes(options: MultitenancyRoutesOptions = {}): void {
  const { prefix = '', health = true, metrics = true } = options

  const define = () => {
    const controller = new HealthController()
    if (health) {
      router.get('/livez', (ctx) => controller.livez(ctx))
      router.get('/readyz', (ctx) => controller.readyz(ctx))
      router.get('/healthz', (ctx) => controller.healthz(ctx))
    }
    if (metrics) {
      router.get('/metrics', (ctx) => controller.metrics(ctx))
    }
  }

  if (prefix) {
    router.group(define).prefix(prefix)
  } else {
    define()
  }
}

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
 * import { multitenancyBillingRoutes } from '@adonisjs-lasagna/saas-tenancy/health'
 * multitenancyBillingRoutes()
 * ```
 *
 * Wires verification middleware → controller. The controller stamps an
 * idempotency row and dispatches the heavy work to `ProcessStripeEventJob`.
 *
 * Idempotent on the host side too — calling more than once would double
 * the route. Guarded behind a check so a misconfigured app doesn't crash
 * boot, but logs a warning so the host notices.
 */
export function multitenancyBillingRoutes(options: MultitenancyBillingRoutesOptions = {}): void {
  const cfg = getConfig().billing
  const path = options.path ?? cfg?.webhook?.path ?? '/webhooks/stripe'

  // Wrap the class middleware as a function so the router invokes it
  // with the standard `(ctx, next)` signature. Passing the instance
  // directly via `.use([instance])` doesn't unpack into a class call —
  // the router treats it as a function middleware and `ctx` lands on
  // the wrong argument, which surfaces as
  // `Cannot read properties of undefined (reading 'ip')` at the first
  // request.ip() access.
  const verify = new VerifyStripeWebhookMiddleware()
  router
    .post(path, (ctx) => new StripeWebhookController().handle(ctx))
    .use(async (ctx, next) => verify.handle(ctx, next))
    .as('billing.webhook')
}
