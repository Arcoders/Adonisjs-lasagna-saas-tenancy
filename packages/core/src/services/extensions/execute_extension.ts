import { Exception } from '@adonisjs/core/exceptions'
import { consumeRateLimit } from '../rate_limiter.js'
import { composeSignals } from '../../utils/signals.js'
import TooManyRequestsException from '../../exceptions/too_many_requests_exception.js'
import RateLimitUnavailableException from '../../exceptions/rate_limit_unavailable_exception.js'
import TelemetryService from '../telemetry_service.js'
import { OBS_SPAN, OBS_ATTR, EXTENSION_OUTCOME } from '../observability/names.js'

const lazyRedis = () => import('@adonisjs/redis/services/main').then((m) => m.default)

/**
 * Raised when an extension overruns its `timeoutMs`. Maps to `504 Gateway
 * Timeout` over HTTP. The deadline is a RESPONSE deadline for the caller. See
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
  /**
   * Caller-facing abort signal, composed with the internal timeout controller on
   * BOTH paths, including the no-timeout fast path. An external abort (budget
   * exhaustion, tenant suspension, client disconnect) then trips `fn`'s signal
   * even when `timeoutMs` is unset. Defaults to none, byte-identical to the
   * previous behavior for callers that pass no signal.
   */
  signal?: AbortSignal
}

/**
 * Run host-supplied extension code under two optional guards: a rate limit and
 * an execution timeout. Both are off unless configured, so an unguarded surface
 * behaves exactly as before.
 *
 * TIMEOUT IS A DEADLINE, NOT CANCELLATION. `Promise.race` resolves the race but
 * cannot stop the underlying work. A timed-out extension keeps running and, if
 * it holds a tenant DB connection, keeps holding it past the deadline. To let
 * cooperative extensions actually stop, we pass an `AbortSignal` to `fn` and
 * abort it when the timer fires; extensions that thread the signal into their
 * `fetch`/queries will unwind. Non-cooperative ones continue in the background.
 * Mind the connection budget (see docs/guides/scaling-limits.md).
 */
export async function executeExtension<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: ExecuteExtensionOptions
): Promise<T> {
  const { label, timeoutMs, rateLimit, failOpen = false } = options

  // Once-per-call: a span carrying the label and a classified outcome. The span
  // wraps the whole body (rate limit + execution) so every terminal state
  // (completed, timeout, aborted, rate_limited, error) is observable in one
  // place. OTel is a no-op tracer when no SDK is wired, so this is free by
  // default; when a stream runs inside `fn`, the span stays active for its
  // duration, which is where a per-fragment settle event lands.
  return TelemetryService.withSpan(
    OBS_SPAN.extensionExecute,
    { [OBS_ATTR.extension]: label },
    async (span) => {
      let signal: AbortSignal | undefined
      try {
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
        // Compose the caller's signal with the internal timeout controller BEFORE the
        // fast-path branch, so an external abort reaches `fn` even when there is no
        // timeout. controller.signal is always present, so the result is never undefined.
        signal = composeSignals([controller.signal, options.signal]) as AbortSignal
        const run = fn(signal)
        if (!timeoutMs) {
          const out = await run
          span.setAttribute(OBS_ATTR.outcome, EXTENSION_OUTCOME.completed)
          return out
        }

        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Reject with the deadline FIRST so it deterministically wins the race:
            // the timeout is the authoritative reason the caller sees. Aborting after
            // is best-effort cleanup. A cooperative fn that rejects on abort settles
            // after the race already resolved, so its error is consumed, not surfaced.
            reject(new ExtensionTimeoutError(timeoutMs, label))
            controller.abort()
          }, timeoutMs)
        })
        try {
          const out = await Promise.race([run, deadline])
          span.setAttribute(OBS_ATTR.outcome, EXTENSION_OUTCOME.completed)
          return out
        } finally {
          if (timer) clearTimeout(timer)
        }
      } catch (error) {
        span.setAttribute(OBS_ATTR.outcome, classifyExtensionOutcome(error, signal))
        throw error
      }
    }
  )
}

/** Map a terminal error to its `extension.execute` outcome attribute value. */
function classifyExtensionOutcome(error: unknown, signal?: AbortSignal): string {
  if (error instanceof ExtensionTimeoutError) return EXTENSION_OUTCOME.timeout
  if (error instanceof TooManyRequestsException) return EXTENSION_OUTCOME.rateLimited
  if (error instanceof RateLimitUnavailableException) return EXTENSION_OUTCOME.rateLimitUnavailable
  if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') {
    return EXTENSION_OUTCOME.aborted
  }
  return EXTENSION_OUTCOME.error
}
