import router from '@adonisjs/core/services/router'
import HealthController from './health_controller.js'

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
