import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import QuotaService from '../services/quota_service.js'

export interface EnforceQuotaOptions {
  amount?: number
  /**
   * When true (default), throws QuotaExceededException on overrun. When false,
   * just lets the request proceed regardless — useful for soft-warn flows.
   */
  enforce?: boolean
}

/**
 * Middleware factory: enforces a quota on every request that reaches it.
 * Resolves the tenant via `request.tenant()` (TenantGuardMiddleware must run
 * earlier) and consumes the requested amount of the named quota.
 *
 * @example
 *   router
 *     .get('/api/expensive', controllerHandler)
 *     .use(enforceQuota('apiCallsPerDay'))
 *
 *   router
 *     .post('/api/upload', uploadHandler)
 *     .use(enforceQuota('uploadsPerDay', { amount: 1 }))
 */
export function enforceQuota(quota: string, options: EnforceQuotaOptions = {}) {
  const amount = options.amount ?? 1
  const enforce = options.enforce !== false

  return async function enforceQuotaMiddleware({ request }: HttpContext, next: NextFn) {
    const tenant = await request.tenant()
    const quotaSvc = await app.container.make(QuotaService)
    if (enforce) {
      await quotaSvc.consume(tenant, quota, amount)
    } else {
      await quotaSvc.track(tenant, quota, amount)
    }
    return next()
  }
}
