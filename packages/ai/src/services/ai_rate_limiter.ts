import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'

/**
 * The injected sliding-window consumer, structurally satisfied by core's
 * `consumeRateLimit` bound to a redis accessor. Injected rather than imported so
 * this module never value-imports the core `/services` barrel (which eagerly
 * loads redis and breaks the bare AI unit runner). Returns the request count in
 * the current window, this hit included.
 */
export type AiRateLimitConsumer = (args: {
  key: string
  windowSeconds: number
}) => Promise<{ count: number }>

/**
 * A per-key request rate-limit window (`config.ai.rateLimit`). Absent means no
 * per-key limit is enforced (the token cost reserve stays the only cap).
 */
export interface AiRateLimitPolicy {
  readonly limit: number
  readonly windowSeconds: number
}

/**
 * Build the BYOK per-key bucket key. Per-tenant is baked in so one tenant can
 * never exhaust another tenant's window; the `keyFingerprint` segment scopes the
 * limit to the specific provider key (threat #4), so a future per-tenant BYOK
 * key gets its own budget with no code change. Colon-delimited to match the
 * kernel's `ext:<surface>:<name>:<tenant>` convention; every segment is a
 * hex/uuid/name with no embedded colon.
 */
export function aiRateLimitKey(op: string, tenantId: string, fingerprint: string): string {
  return `ext:ai:${op}:${tenantId}:${fingerprint}`
}

/**
 * The AI per-key request rate limiter (WS-AI-2, threat #4 BYOK exploitation /
 * denial of wallet). It is a DIFFERENT rail from the token cost reserve: this
 * caps requests-per-window on a provider key, the reserve caps token spend. They
 * compose without double-counting (one counts requests, the other holds tokens).
 *
 * Fail-closed by construction. Over the window is a `rate_limited` (429); a
 * limiter-backend outage is a `rate_limit_unavailable` (503), never a silent
 * pass, because an AI cost surface must not run unmetered when the limiter is
 * blind. A policy denial rides the public `IsthmusGuardTripped` channel via
 * `guard.ai_rate_limited`; an outage does not (it is a dependency outage,
 * classified like the reserve rail's, not a guard trip).
 *
 * Register it as a container singleton (its redis-backed consumer is injected in
 * the AI provider, the one sanctioned toucher of the eager core barrel).
 */
export default class AiRateLimiter {
  readonly #consume: AiRateLimitConsumer
  readonly #policy: AiRateLimitPolicy | undefined

  constructor(deps: { consume: AiRateLimitConsumer; policy?: AiRateLimitPolicy }) {
    this.#consume = deps.consume
    this.#policy = deps.policy
  }

  /** Whether a per-key rate limit is configured. When false, `check` is a no-op. */
  get enabled(): boolean {
    return this.#policy !== undefined
  }

  /**
   * Consume one hit against `ext:ai:<op>:<tenant>:<keyFingerprint>`. A no-op when
   * no policy is configured. Called pre-flight (before the reserve and before any
   * byte), so both refusals surface as the AIException's own HTTP status with the
   * SSE headers unsent.
   */
  async check(params: { op: string; tenantId: string; fingerprint: string }): Promise<void> {
    const policy = this.#policy
    if (!policy) return

    const key = aiRateLimitKey(params.op, params.tenantId, params.fingerprint)
    let count: number
    try {
      ;({ count } = await this.#consume({ key, windowSeconds: policy.windowSeconds }))
    } catch {
      // Backend outage: fail-closed, matching the reserve rail and the kernel
      // rate-limit default. Not a guard trip (a dependency outage, not a policy
      // refusal of untrusted input), so no IsthmusGuardTripped emission.
      throw new AIException('rate_limit_unavailable', 'the AI rate limiter backend is unavailable')
    }

    if (count > policy.limit) {
      emitAiGuardEvent('guard.ai_rate_limited', {
        tenantId: params.tenantId,
        metadata: { op: params.op.slice(0, 64) },
      })
      throw new AIException(
        'rate_limited',
        'Refusing to stream: the AI request rate limit was exceeded'
      )
    }
  }
}

/**
 * A shared no-op limiter for call sites that do not inject one (the gateway
 * controller's default). Its policy is absent, so `check` returns immediately and
 * the consumer is never invoked. The real limiter is always injected by the AI
 * provider from `config.ai.rateLimit`.
 */
export const DISABLED_AI_RATE_LIMITER = new AiRateLimiter({
  consume: async () => ({ count: 0 }),
  policy: undefined,
})
