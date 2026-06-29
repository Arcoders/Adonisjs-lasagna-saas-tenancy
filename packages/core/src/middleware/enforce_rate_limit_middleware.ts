import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import RateLimitMiddleware from './rate_limit_middleware.js'
import QuotaService from '../services/quota_service.js'

/**
 * Per-route configuration accepted by the `enforceRateLimit()` middleware factory. Each
 * field overrides a default that otherwise comes from the resolved plan's `rateLimit`
 * block or global config: `windowSeconds` shortens the plan window for a burst-sensitive
 * route, `failOpen` overrides the global Redis-failure policy, `prefix` sets the Redis
 * bucket key prefix (default `'rl'`), and `bypassInTestEnv` re-enables the limiter under
 * `app.inTest`. All properties are optional, so an empty object falls back to plan defaults.
 */
export interface EnforceRateLimitOptions {
  /**
   * Override the window from the plan's `rateLimit.windowSeconds`. Useful when
   * one route should burst over a shorter window than the plan default.
   */
  windowSeconds?: number
  /**
   * Per-route override of the Redis-failure policy. When unset the global
   * `config.resilience.redis.rateLimit` policy applies (default `fail-closed`).
   */
  failOpen?: boolean
  /** Bucket key prefix. Default `'rl'`, matching `RateLimitMiddleware`. */
  prefix?: string
  /**
   * Forwarded to `RateLimitMiddleware`: opt back into the limiter under
   * `app.inTest` (where it otherwise short-circuits). Test-suite plumbing only.
   */
  bypassInTestEnv?: boolean
}

type PlanResolver = Pick<QuotaService, 'getPlanFor'>
type PlanResolverFactory = () => Promise<PlanResolver>
type Limiter = Pick<RateLimitMiddleware, 'handle'>

let resolveQuotaService: PlanResolverFactory = () => app.container.make(QuotaService)
let createLimiter: () => Limiter = () => new RateLimitMiddleware()

/**
 * Test-only: swap how the factory resolves `QuotaService` so unit tests can
 * exercise plan resolution without a booted container. Pass `undefined` to
 * restore the default. Not re-exported from the public barrel.
 */
export function __setRateLimitServiceResolverForTests(
  resolver: PlanResolverFactory | undefined
): void {
  resolveQuotaService = resolver ?? (() => app.container.make(QuotaService))
}

/**
 * Test-only: swap the underlying `RateLimitMiddleware` so unit tests can assert
 * the synthesized options without opening a Redis connection. Pass `undefined`
 * to restore the default. Not re-exported from the public barrel.
 */
export function __setRateLimiterForTests(factory: (() => Limiter) | undefined): void {
  createLimiter = factory ?? (() => new RateLimitMiddleware())
}

/**
 * Middleware factory: plan-aware per-tenant rate limiting. Resolves the tenant
 * via `request.tenant()` (TenantGuardMiddleware must run earlier), reads the
 * active plan's `rateLimit` block via `QuotaService.getPlanFor()`, and delegates
 * to the existing `RateLimitMiddleware` with the plan's `limit`/`windowSeconds`.
 *
 * The plan must declare a `rateLimit` block (see {@link PlanDefinition}); a plan
 * without one is not routable through this middleware and the request throws —
 * an unlimited tier simply omits the middleware on its routes.
 *
 * @example
 *   router.get('/api/expensive', handler).use(enforceRateLimit())
 *   router.post('/api/upload', handler).use(enforceRateLimit({ windowSeconds: 300 }))
 */
export function enforceRateLimit(options: EnforceRateLimitOptions = {}) {
  const middleware = createLimiter()

  return async function enforceRateLimitMiddleware(ctx: HttpContext, next: NextFn) {
    const tenant = await ctx.request.tenant()
    const quota = await resolveQuotaService()
    const { plan } = await quota.getPlanFor(tenant)

    if (!plan.rateLimit) {
      throw new Error(
        'enforceRateLimit(): the resolved plan declares no `rateLimit` block. ' +
          'Add a `rateLimit` to the plan in config.plans.definitions, or drop this ' +
          'middleware from the route — unlimited tiers cannot use enforceRateLimit.'
      )
    }

    const limit = plan.rateLimit.limit
    const windowSeconds = options.windowSeconds ?? plan.rateLimit.windowSeconds
    // Range-check the resolved values before they reach Redis. A misconfigured
    // `windowSeconds <= 0` becomes `EXPIRE key 0|-1` (immediate key deletion),
    // silently disabling the limiter; `limit <= 0` would reject every request.
    // Fail loud at the boundary instead.
    if (
      !Number.isFinite(limit) ||
      limit <= 0 ||
      !Number.isFinite(windowSeconds) ||
      windowSeconds <= 0
    ) {
      throw new Error(
        `enforceRateLimit(): invalid rate limit (limit=${limit}, windowSeconds=${windowSeconds}). ` +
          'Both the plan `rateLimit` values and any per-route `windowSeconds` override must be ' +
          'finite numbers greater than 0.'
      )
    }

    return middleware.handle(ctx, next, {
      limit,
      windowSeconds,
      prefix: options.prefix ?? 'rl',
      failOpen: options.failOpen,
      bypassInTestEnv: options.bypassInTestEnv,
    })
  }
}
