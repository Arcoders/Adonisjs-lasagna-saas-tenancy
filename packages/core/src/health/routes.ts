import router from '@adonisjs/core/services/router'
import HealthController from './health_controller.js'
import { assertMetricsGuarded } from './assert_metrics_guarded.js'
// The Stripe webhook route (`multitenancyBillingRoutes`) moved to
// `@adonisjs-lasagna/billing`.

/**
 * A single middleware entry, in any shape Adonis' `group.use(...)` accepts at
 * runtime: a registered name, a middleware function, or a named-middleware
 * reference produced by `router.named(...)` (the `middleware.auth()` shape,
 * which carries a `handle` method). Mirrors the admin routes' middleware type so
 * the same `middleware.x()` value works for both.
 */
export type RouteMiddlewareEntry =
  | string
  | ((...args: any[]) => any)
  | { name?: string; handle: (...args: any[]) => any }

/**
 * Type accepted by the `metricsMiddleware` option of `multitenancyRoutes`, used
 * to guard the `/metrics` endpoint. It is either a single `RouteMiddlewareEntry`
 * or an array of them, where each entry is a registered middleware name, a
 * middleware function, or a `router.named(...)` reference carrying a `handle`
 * method. The union lets callers pass one middleware or several to protect the
 * tenant-labelled Prometheus output.
 */
export type RouteMiddleware = RouteMiddlewareEntry | RouteMiddlewareEntry[]

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
   * and business metrics.
   *
   * REQUIRED when `metrics` is enabled (the default). The endpoint refuses to
   * mount without it — pass your auth (or a network guard) here, or pass
   * `metricsMiddleware: false` to intentionally mount it public (only ever
   * behind a trusted network boundary such as a private VPC or an
   * authenticating gateway). Omitting both throws at startup. This mirrors the
   * fail-closed posture of `multitenancyAdminRoutes`.
   *
   * `/livez` and `/readyz` are intentionally left public — Kubernetes probes
   * must reach them without auth.
   */
  metricsMiddleware?: RouteMiddleware | false
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

  // Fail closed, BEFORE registering any route: /metrics leaks tenant
  // enumeration + business metrics, so it must not mount silently public. The
  // rule lives in a router-free module so the misuse throws before a single
  // `router.get` runs (fail fast) and stays unit-testable. Mirrors
  // `multitenancyAdminRoutes`.
  assertMetricsGuarded(metrics, metricsMiddleware)

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
    // `false` is the explicit "mount public" opt-out; anything else is real middleware.
    if (metricsMiddleware !== false) (group as any).use(metricsMiddleware)
  }
}
