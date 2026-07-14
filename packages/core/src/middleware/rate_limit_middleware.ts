import { resolveTenantId } from '../extensions/request.js'
import { guardedSafeIdentifier } from '../isthmus/guarded_identifier.js'
import { tenancy } from '../tenancy.js'
import { getConfig } from '../config.js'
import { consumeRateLimit } from '../services/rate_limiter.js'
import RateLimitUnavailableException from '../exceptions/rate_limit_unavailable_exception.js'
import TooManyRequestsException from '../exceptions/too_many_requests_exception.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

const lazyRedis = () => import('@adonisjs/redis/services/main').then((m) => m.default)

/**
 * Per-route configuration object passed to the rate-limit middleware. It declares
 * the sliding-window quota through `limit` and `windowSeconds`, the optional Redis
 * key `prefix` used to namespace buckets, the `failOpen` policy that decides whether
 * a Redis outage rejects requests with 503 or lets them through, and `bypassInTestEnv`
 * which forces the middleware to run instead of short-circuiting under `app.inTest`.
 */
export interface RateLimitOptions {
  limit: number
  windowSeconds: number
  prefix?: string
  /**
   * What to do when the rate-limit backend (Redis) raises an error.
   *
   * When unset, the global `config.resilience.redis.rateLimit` policy
   * applies (default `'fail-closed'`): a Redis outage must not silently
   * disable rate limiting; we'd rather return 503 than let a flood
   * through. Set to `true` (per route) only if your threat model prefers
   * availability over abuse protection on the affected route. An explicit
   * per-route value always wins over the global policy.
   */
  failOpen?: boolean | undefined
  /**
   * The middleware short-circuits when `app.inTest` is true so the rest
   * of the integration suite isn't gated on Redis. Tests that target
   * the rate-limit codepath itself must opt in by setting this to true.
   */
  bypassInTestEnv?: boolean | undefined
}

/**
 * AdonisJS HTTP middleware that enforces a per-tenant, per-IP sliding-window rate
 * limit backed by Redis. Its handle method builds a bucket key from the prefix,
 * the resolved tenant id, and the client IP, then consumes the shared
 * sliding-window counter, emitting standard X-RateLimit headers and throwing a 429
 * TooManyRequestsException when the configured limit is exceeded. On a Redis backend
 * failure it applies the fail-open or fail-closed policy, returning 503 by default.
 * It also bypasses itself in the test environment unless a route opts in.
 */
export default class RateLimitMiddleware {
  /**
   * Override hook for tests: lets a spec swap in a Redis stub that
   * throws on demand. Production code lazy-loads the real `redis`
   * service from `@adonisjs/redis` so this module can be imported
   * without booting the AdonisJS app (e.g. from unit tests).
   */
  protected getRedis(): Promise<any> {
    return lazyRedis()
  }

  /**
   * Override hook so unit specs can simulate `app.inTest === true`
   * without booting AdonisJS. The default reads from the running app;
   * if the app isn't booted yet (early init / unit tests) we treat it
   * as production so the middleware codepath is exercised.
   */
  protected isTestEnv(): boolean {
    return (app as any)?.inTest === true
  }

  /**
   * Global fallback for routes that don't pass an explicit `failOpen`:
   * `config.resilience.redis.rateLimit`. Defaults to fail-closed, both when
   * the key is unset and when config isn't booted yet (unit environments).
   */
  protected configuredFailOpen(): boolean {
    try {
      return getConfig().resilience?.redis?.rateLimit === 'fail-open'
    } catch {
      return false
    }
  }

  /**
   * Seam (same pattern as the impersonation middleware) so unit specs can
   * exercise attribution without an AsyncLocalStorage context.
   */
  protected currentTenantId(): string | undefined {
    return tenancy.currentId()
  }

  async handle({ request, response }: HttpContext, next: NextFn, options: RateLimitOptions) {
    const { limit, windowSeconds, prefix = 'rl', bypassInTestEnv = false } = options
    const failOpen = options.failOpen ?? this.configuredFailOpen()

    if (this.isTestEnv() && !bypassInTestEnv) {
      return next()
    }

    // `request.ip()` honours X-Forwarded-For only per the app's `trustProxy`
    // config. A misconfigured trustProxy lets a client mint fresh buckets per
    // spoofed XFF value. Document/verify trustProxy wherever this middleware
    // is enabled behind a proxy.
    const ip = request.ip()
    // Attribution: prefer the canonical id the guard already resolved
    // (`tenancy.currentId()`), then `resolveTenantId` (the SAME chain-aware
    // authority routing uses) for routes where rate-limit runs before (or
    // without) the guard. Attributing by the routing authority is what keeps a
    // `resolverChain` deployment from bucketing under a DIFFERENT tenant than the
    // one served (or collapsing everyone into the per-IP 'global' bucket), which
    // would let one tenant starve the others' quota.
    //
    // Defense-in-depth: `resolveTenantId` re-reads a client-controlled
    // header/segment, and a CUSTOM resolver may mint a non-UUID id, so it must be
    // a `SAFE_IDENT` before it can become a bucket key: a value carrying `:`
    // would inject key structure, an arbitrary string would let a caller mint or
    // pollute buckets. A non-safe (or absent) id degrades to the shared per-IP
    // `global` bucket rather than an attacker-chosen tenant attribution.
    // `guardedSafeIdentifier` emits `guard.tenant_identifier` for a PRESENT-but-
    // unsafe id (a forged attribution, audited not silently dropped); an absent
    // id (the ordinary untenanted route) degrades quietly.
    const resolved = this.currentTenantId() ?? resolveTenantId(request)
    const tenantId = guardedSafeIdentifier(resolved, 'rate-limit tenant id') ? resolved : 'global'
    const key = `${prefix}:${tenantId}:${ip}`

    // The sliding-window counter (pipeline + ioredis outage detection) is the
    // shared `consumeRateLimit` primitive; this middleware keeps ownership of
    // attribution (the `key` above), the response headers, the 429, and the
    // fail-open/closed policy below. `consumeRateLimit` THROWS on any backend
    // failure, so the catch engages the configured policy exactly as before.
    let count: number
    let now: number
    try {
      const reading = await consumeRateLimit({
        getRedis: () => this.getRedis(),
        key,
        windowSeconds,
      })
      count = reading.count
      now = reading.now
    } catch (error) {
      await warn('redis_pipeline_failed', error, { tenantId, key })
      // Unified observability: the same DependencyDegraded signal QuotaService
      // emits via ResilienceService, so ops alarm on one event for any
      // Redis-backed subsystem. The per-route `failOpen` stays the policy knob
      // here (rate-limit policy is naturally per-route).
      await emitRedisDegraded(tenantId, failOpen, error)
      if (failOpen) return next()
      throw new RateLimitUnavailableException()
    }

    response.header('X-RateLimit-Limit', String(limit))
    response.header('X-RateLimit-Remaining', String(Math.max(0, limit - count)))
    response.header('X-RateLimit-Reset', String(Math.ceil((now + windowSeconds * 1000) / 1000)))

    if (count > limit) {
      response.header('Retry-After', String(windowSeconds))
      throw new TooManyRequestsException()
    }

    return next()
  }
}

async function emitRedisDegraded(tenantId: string, failOpen: boolean, err: unknown): Promise<void> {
  try {
    const { default: DependencyDegraded } = await import('../events/dependency_degraded.js')
    await DependencyDegraded.dispatch({
      dependency: 'redis',
      operation: 'rateLimit.check',
      tenantId,
      policy: failOpen ? 'fail-open' : 'fail-closed',
      errorCode: (err as { code?: string })?.code ?? (err as Error)?.name ?? 'unknown',
    })
  } catch {
    // Best-effort: observability must never break the middleware.
  }
}

async function warn(kind: string, err: unknown, ctx: Record<string, unknown>): Promise<void> {
  try {
    const logger = await app.container.make('logger').catch(() => undefined)
    const message = (err as any)?.message ?? String(err)
    if (logger) {
      logger.warn(
        { middleware: 'rate_limit', kind, error: message, ...ctx },
        'multitenancy: rate-limit middleware encountered a backend error'
      )
      return
    }
  } catch {
    // ignore: logging must never throw out of the middleware
  }
  console.warn(`[multitenancy] rate-limit middleware ${kind}:`, (err as any)?.message ?? err, ctx)
}
