import { randomUUID } from 'node:crypto'

export interface ConsumeRateLimitArgs {
  /**
   * Redis accessor, injected so this stays importable without a booted app
   * (the same seam the rate-limit middleware uses for its Redis stub).
   */
  getRedis: () => Promise<any>
  /** The bucket key. The caller owns attribution (tenant/ip/name namespacing). */
  key: string
  windowSeconds: number
}

export interface RateLimitReading {
  /** Requests counted in the current window, this hit included. */
  count: number
  /** Timestamp (ms) used as the ZSET score; callers derive the reset from it. */
  now: number
}

/**
 * Run the sliding-window counter for one hit against `key` and return the
 * current count. Lifted verbatim out of `RateLimitMiddleware` so the proven
 * outage detection is shared with the extension execution guard
 * ({@link ./extensions/execute_extension.js}).
 *
 * ioredis does NOT reject `exec()` when the backend is unreachable — it
 * RESOLVES with per-command `[error, value]` tuples. So a Redis outage shows up
 * here as a missing result set, a per-command error, or a non-numeric ZCARD,
 * and we THROW in all three cases. Callers (middleware, executeExtension) own
 * the fail-open / fail-closed policy; this primitive never decides it.
 */
export async function consumeRateLimit(args: ConsumeRateLimitArgs): Promise<RateLimitReading> {
  const { getRedis, key, windowSeconds } = args
  const now = Date.now()
  const windowStart = now - windowSeconds * 1000

  const r = await getRedis()
  const pipeline = r.pipeline()
  pipeline.zremrangebyscore(key, '-inf', windowStart)
  // The member must be unique per request: the score (`now`) drives window
  // pruning, but two requests in the SAME millisecond would share the member
  // `${now}` and ZADD would de-duplicate them, so ZCARD undercounts. A random
  // suffix keeps every request a distinct member (also across processes).
  pipeline.zadd(key, now, `${now}-${randomUUID()}`)
  pipeline.zcard(key)
  pipeline.expire(key, windowSeconds)

  const results = await pipeline.exec()
  if (!results) throw new Error('rate-limit pipeline returned no results')
  const commandError = results.find((entry: [Error | null, unknown]) => entry?.[0])?.[0]
  if (commandError) throw commandError
  const zcard = results[2]?.[1]
  if (typeof zcard !== 'number') {
    throw new Error('rate-limit pipeline returned a non-numeric zcard result')
  }
  return { count: zcard, now }
}
