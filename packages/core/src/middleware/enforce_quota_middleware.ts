import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import QuotaService from '../services/quota_service.js'

/**
 * Configuration options passed to the `enforceQuota` middleware factory. The optional
 * `amount` field sets how many units of the named quota each request consumes,
 * defaulting to 1, and the optional `enforce` field controls whether an overrun throws
 * a QuotaExceededException via `consume` or merely records usage via `track`, defaulting
 * to true for hard enforcement.
 */
export interface EnforceQuotaOptions {
  amount?: number
  /**
   * When true (default), throws QuotaExceededException on overrun. When false,
   * just lets the request proceed regardless, useful for soft-warn flows.
   */
  enforce?: boolean
}

type QuotaConsumer = Pick<QuotaService, 'consume' | 'track'>
type QuotaServiceResolver = () => Promise<QuotaConsumer>

let resolveQuotaService: QuotaServiceResolver = () => app.container.make(QuotaService)

/**
 * Test-only: swap how the middleware resolves `QuotaService` so unit tests can
 * exercise the factory's branches without a booted container. Pass `undefined`
 * to restore the default. Not re-exported from the public barrel.
 */
export function __setQuotaServiceResolverForTests(
  resolver: QuotaServiceResolver | undefined
): void {
  resolveQuotaService = resolver ?? (() => app.container.make(QuotaService))
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
    const quotaSvc = await resolveQuotaService()
    if (enforce) {
      await quotaSvc.consume(tenant, quota, amount)
    } else {
      await quotaSvc.track(tenant, quota, amount)
    }
    return next()
  }
}
