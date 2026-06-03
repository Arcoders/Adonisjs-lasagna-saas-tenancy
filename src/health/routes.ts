import router from '@adonisjs/core/services/router'
import HealthController from './health_controller.js'
// The Stripe webhook route (`multitenancyBillingRoutes`) moved to
// `@adonisjs-lasagna/billing`.

/**
 * Middleware accepted by {@link MultitenancyRoutesOptions.metricsMiddleware}.
 * A registered name, a callable, or an array of either — same shape Adonis'
 * `group.use(...)` accepts.
 */
export type RouteMiddleware =
  | string
  | string[]
  | ((...args: any[]) => any)
  | Array<string | ((...args: any[]) => any)>

export interface MultitenancyRoutesOptions {
  /** URL prefix for all mounted endpoints. Defaults to no prefix (root paths). */
  prefix?: string
  /** Mount /healthz, /livez, /readyz endpoints. Default true. */
  health?: boolean
  /** Mount /metrics (Prometheus text-exposition) endpoint. Default true. */
  metrics?: boolean
  /**
   * Middleware applied to `/metrics` only. The Prometheus output carries
   * per-tenant labels (circuit-breaker state, queue depths) plus total /
   * by-status tenant counts, so a public `/metrics` leaks tenant enumeration
   * and business metrics. Pass your auth (or a network guard) here, or restrict
   * the endpoint at the network layer.
   *
   * `/livez` and `/readyz` are intentionally left public — Kubernetes probes
   * must reach them without auth.
   */
  metricsMiddleware?: RouteMiddleware
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
  const { prefix = '', health = true, metrics = true, metricsMiddleware } = options
  const controller = new HealthController()

  // Probes stay public (k8s needs them unauthenticated).
  if (health) {
    const defineHealth = () => {
      router.get('/livez', (ctx) => controller.livez(ctx))
      router.get('/readyz', (ctx) => controller.readyz(ctx))
      router.get('/healthz', (ctx) => controller.healthz(ctx))
    }
    if (prefix) router.group(defineHealth).prefix(prefix)
    else defineHealth()
  }

  // `/metrics` mounts in its own group so it can carry `metricsMiddleware`
  // without gating the liveness/readiness probes.
  if (metrics) {
    const group = router.group(() => {
      router.get('/metrics', (ctx) => controller.metrics(ctx))
    })
    if (prefix) group.prefix(prefix)
    if (metricsMiddleware) (group as any).use(metricsMiddleware)
  }
}
