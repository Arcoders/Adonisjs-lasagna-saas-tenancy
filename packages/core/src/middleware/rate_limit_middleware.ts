import { resolveTenantId } from '../extensions/request.js'
import { getConfig } from '../config.js'
import RateLimitUnavailableException from '../exceptions/rate_limit_unavailable_exception.js'
import TooManyRequestsException from '../exceptions/too_many_requests_exception.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

const lazyRedis = () => import('@adonisjs/redis/services/main').then((m) => m.default)

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
   * availability over abuse protection on the affected route — an explicit
   * per-route value always wins over the global policy.
   */
  failOpen?: boolean
  /**
   * The middleware short-circuits when `app.inTest` is true so the rest
   * of the integration suite isn't gated on Redis. Tests that target
   * the rate-limit codepath itself must opt in by setting this to true.
   */
  bypassInTestEnv?: boolean
}

export default class RateLimitMiddleware {
  /**
   * Override hook for tests — lets a spec swap in a Redis stub that
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

  async handle({ request, response }: HttpContext, next: NextFn, options: RateLimitOptions) {
    const { limit, windowSeconds, prefix = 'rl', bypassInTestEnv = false } = options
    const failOpen = options.failOpen ?? this.configuredFailOpen()

    if (this.isTestEnv() && !bypassInTestEnv) {
      return next()
    }

    const ip = request.ip()
    const tenantId = resolveTenantId(request) ?? 'global'
    const key = `${prefix}:${tenantId}:${ip}`

    const now = Date.now()
    const windowStart = now - windowSeconds * 1000

    let count: number
    try {
      const r = await this.getRedis()
      const pipeline = r.pipeline()
      pipeline.zremrangebyscore(key, '-inf', windowStart)
      pipeline.zadd(key, now, `${now}`)
      pipeline.zcard(key)
      pipeline.expire(key, windowSeconds)

      const results = await pipeline.exec()
      // ioredis resolves `exec()` with per-command `[error, value]` tuples and
      // does NOT reject when the backend is unreachable. So a Redis outage lands
      // here, not in `catch`, with each tuple carrying an error and a null value.
      // Detect a missing result set or any per-command error (or a non-numeric
      // zcard) and treat it as a backend failure, so the configured fail policy
      // actually engages. Without this, `count` silently defaulted to 0 and the
      // limiter failed OPEN on a Redis outage — the opposite of the default.
      if (!results) throw new Error('rate-limit pipeline returned no results')
      const commandError = results.find((entry: [Error | null, unknown]) => entry?.[0])?.[0]
      if (commandError) throw commandError
      const zcard = results[2]?.[1]
      if (typeof zcard !== 'number') {
        throw new Error('rate-limit pipeline returned a non-numeric zcard result')
      }
      count = zcard
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
    // ignore — logging must never throw out of the middleware
  }
  console.warn(`[multitenancy] rate-limit middleware ${kind}:`, (err as any)?.message ?? err, ctx)
}
