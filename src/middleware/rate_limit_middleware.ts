import { resolveTenantId } from '../extensions/request.js'
import RateLimitUnavailableException from '../exceptions/rate_limit_unavailable_exception.js'
import TooManyRequestsException from '../exceptions/too_many_requests_exception.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default)

export interface RateLimitOptions {
  limit: number
  windowSeconds: number
  prefix?: string
  /**
   * What to do when the rate-limit backend (Redis) raises an error.
   *
   * Default is `false` — fail CLOSED. A Redis outage must not silently
   * disable rate limiting; we'd rather return 503 than let a flood
   * through. Set to `true` only if your threat model prefers
   * availability over abuse protection on the affected route.
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

  async handle({ request, response }: HttpContext, next: NextFn, options: RateLimitOptions) {
    const { limit, windowSeconds, prefix = 'rl', failOpen = false, bypassInTestEnv = false } = options

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
      count = (results?.[2]?.[1] as number) ?? 0
    } catch (error) {
      await warn('redis_pipeline_failed', error, { tenantId, key })
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
  console.warn(
    `[multitenancy] rate-limit middleware ${kind}:`,
    (err as any)?.message ?? err,
    ctx
  )
}
