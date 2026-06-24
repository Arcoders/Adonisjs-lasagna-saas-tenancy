import { Exception } from '@adonisjs/core/exceptions'
import { consumeRateLimit } from '../rate_limiter.js'
import TooManyRequestsException from '../../exceptions/too_many_requests_exception.js'
import RateLimitUnavailableException from '../../exceptions/rate_limit_unavailable_exception.js'

const lazyRedis = () => import('@adonisjs/redis/services/main').then((m) => m.default)

/**
 * Raised when an extension overruns its `timeoutMs`. Maps to `504 Gateway
 * Timeout` over HTTP. The deadline is a RESPONSE deadline for the caller — see
 * the caveat on {@link executeExtension}.
 */
export class ExtensionTimeoutError extends Exception {
  static status = 504
  static code = 'E_EXTENSION_TIMEOUT'
  constructor(
    readonly timeoutMs: number,
    readonly label: string
  ) {
    super(`Extension "${label}" exceeded its ${timeoutMs}ms execution deadline.`)
  }
}

export interface ExecuteExtensionOptions {
  /** Names the extension; used in the timeout error and the rate-limit bucket. */
  label: string
  timeoutMs?: number
  rateLimit?: { limit: number; windowSeconds: number }
  /**
   * Rate-limit bucket key. Callers own attribution: HTTP routes pass
   * `ext:<surface>:<name>:<tenantId>:<ip>`; CLI/programmatic callers (no ip)
   * pass `ext:<surface>:<name>:<tenantId>`. Defaults to `ext:<label>`.
   */
  rateLimitKey?: string
  /** Redis accessor seam; defaults to the app's redis service. */
  getRedis?: () => Promise<any>
  /**
   * On a rate-limit *backend outage* (Redis down): `true` lets the call
   * through, `false` rejects with 503. Defaults to `false` (fail-closed),
   * matching the rate-limit middleware. Only relevant when `rateLimit` is set.
   */
  failOpen?: boolean
}

/**
 * Run host-supplied extension code under two optional guards: a rate limit and
 * an execution timeout. Both are off unless configured, so an unguarded surface
 * behaves exactly as before.
 *
 * TIMEOUT IS A DEADLINE, NOT CANCELLATION. `Promise.race` resolves the race but
 * cannot stop the underlying work — a timed-out extension keeps running and, if
 * it holds a tenant DB connection, keeps holding it past the deadline. To let
 * cooperative extensions actually stop, we pass an `AbortSignal` to `fn` and
 * abort it when the timer fires; extensions that thread the signal into their
 * `fetch`/queries will unwind. Non-cooperative ones continue in the background
 * (mind the connection budget — see docs/scaling-limits).
 */
export async function executeExtension<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: ExecuteExtensionOptions
): Promise<T> {
  const { label, timeoutMs, rateLimit, failOpen = false } = options

  if (rateLimit) {
    const key = options.rateLimitKey ?? `ext:${label}`
    try {
      const { count } = await consumeRateLimit({
        getRedis: options.getRedis ?? lazyRedis,
        key,
        windowSeconds: rateLimit.windowSeconds,
      })
      if (count > rateLimit.limit) throw new TooManyRequestsException()
    } catch (error) {
      // A real 429 must surface; only a backend OUTAGE is subject to failOpen.
      if (error instanceof TooManyRequestsException) throw error
      if (!failOpen) throw new RateLimitUnavailableException()
    }
  }

  const controller = new AbortController()
  const run = fn(controller.signal)
  if (!timeoutMs) return run

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject with the deadline FIRST so it deterministically wins the race:
      // the timeout is the authoritative reason the caller sees. Aborting after
      // is best-effort cleanup — a cooperative fn that rejects on abort settles
      // after the race already resolved, so its error is consumed, not surfaced.
      reject(new ExtensionTimeoutError(timeoutMs, label))
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([run, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
