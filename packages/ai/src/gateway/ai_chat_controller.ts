import type { HttpContext } from '@adonisjs/core/http'
import type StreamExtensionService from './stream_extension.js'
import {
  httpStreamTarget,
  type StreamPreflightError,
  type StreamResult,
} from './stream_extension.js'
import type AIProviderRegistry from '../services/ai_provider_registry.js'
import type TenantLivenessWatcher from '../services/tenant_liveness_watcher.js'
import type AiIdempotencyService from './idempotency.js'
import {
  validateIdempotencyKeyHeader,
  type AiIdempotencyScope,
  type CachedAiResponse,
} from './idempotency.js'
import { authorizeAiAccess, resolveRequestTenant } from './access_gate.js'
import recordingStreamTarget from './recording_target.js'
import AIException from '../exceptions/ai_exception.js'
import { assertNever } from '../internal/assert_never.js'
import type { AiConfig } from '../define_config.js'
import type { AIMessage, AIStreamRequest, StreamFragment } from '../types/ai_provider_contract.js'
import {
  AI_FRAGMENT_MAX_CHARS,
  AI_IDEMPOTENCY_MAX_BYTES,
  AI_TOKENS_QUOTA,
  DEFAULT_AI_MAX_PROMPT_CHARS,
  DEFAULT_AI_MAX_TOKENS,
} from '../constants.js'

/** The chat request body. Everything else in the body is ignored. */
interface ChatBody {
  messages: AIMessage[]
  model?: string
  maxTokens?: number
  sessionId?: string
}

export interface AiChatControllerDeps {
  stream: StreamExtensionService
  registry: AIProviderRegistry
  idempotency: AiIdempotencyService
  liveness: TenantLivenessWatcher
  config: AiConfig | undefined
}

/**
 * The single choke point (WS-AI-6): every model call flows through `chat`, in
 * the ARCHITECTURE.md sequence order, which is deliberate: authorization
 * first (a denied caller spends nothing), reserve before the provider call
 * (inside the streaming spine), settle/release in its finally, and the
 * response idempotency-cached only when it completed.
 *
 * All dependencies are container singletons resolved by the route closure and
 * injected here, so this module never value-imports the eager core barrels
 * and unit-tests with doubles. Instantiated per request (it is stateless).
 *
 * ContextSeal constraint (kernel, doc-level for this WS): no code below runs
 * a tenant-scoped model query. When WS-AI-3 adds retrieval inside the stream,
 * that query MUST run under this request's own tenant scope, or the kernel's
 * ContextSeal refuses it with a typed 500.
 */
export default class AiChatController {
  constructor(private readonly deps: AiChatControllerDeps) {}

  async chat(ctx: HttpContext): Promise<void> {
    const ai = this.deps.config

    // 1. Tenant + membership gate (403s, before any cost).
    const tenant = await resolveRequestTenant(ctx)
    await authorizeAiAccess(ctx, tenant, ai)

    // 2. Request validation (400s, still before any cost).
    const body = parseChatBody(ctx.request.body(), ai)
    const worstCase = resolveWorstCase(body.maxTokens, ai)

    // 3. Idempotency scope: only with a well-formed header AND a resolvable
    //    principal (a cached response must never be shareable across unknown
    //    callers, so principal-less requests get no idempotency at all).
    const headerKey = ctx.request.header('idempotency-key')
    let scope: AiIdempotencyScope | null = null
    if (headerKey !== undefined) {
      const validated = validateIdempotencyKeyHeader(headerKey, tenant.id)
      const principal = resolvePrincipal(ctx, ai)
      if (principal !== null) {
        scope = {
          tenantId: tenant.id,
          principal,
          sessionId: body.sessionId ?? null,
          headerKey: validated,
        }
      }
    }

    // 4. Replay: same bytes, no reservation, no provider call, no charge.
    if (scope) {
      const cached = await this.deps.idempotency.lookup(scope)
      if (cached) {
        this.#replay(ctx, cached)
        return
      }
    }

    // 5. Provider selection (default-deny; AIException statuses propagate:
    //    403 provider_not_allowed / 503 provider_unavailable / 500 config_missing).
    const provider = this.deps.registry.forTenant(tenant, ai)
    const request: AIStreamRequest = {
      messages: body.messages,
      model: body.model,
      maxTokens: worstCase,
    }

    // 6. The stream itself: liveness handle for G11, a recording tee for the
    //    idempotency cache, the spine for everything else.
    const liveness = this.deps.liveness.acquire(tenant.id)
    const recorder = recordingStreamTarget(httpStreamTarget(ctx), {
      maxBytes: AI_IDEMPOTENCY_MAX_BYTES,
    })
    let result: StreamResult
    try {
      result = await this.deps.stream.stream(
        recorder.target,
        (signal) => provider.stream(request, signal),
        {
          label: 'ai:chat',
          tenant,
          quota: AI_TOKENS_QUOTA,
          worstCase,
          timeoutMs: ai?.timeoutMs,
          heartbeatMs: ai?.heartbeatMs,
          lastEventId: ctx.request.header('last-event-id'),
          livenessSignal: liveness.signal,
          validateFragment: boundedFragmentGate,
          provider: provider.name,
          model: body.model,
        }
      )
    } finally {
      liveness.dispose()
    }

    // 7. Resolution. Preflight failures left headers unsent (the spine's
    //    commit-point contract), so a real status still applies; committed
    //    outcomes end the SSE stream with a terminal `done` frame.
    switch (result.outcome) {
      case 'failed_preflight': {
        ctx.response.status(preflightStatus(result.error)).send({ error: result.error })
        return
      }
      case 'completed': {
        this.#finishSse(ctx, { outcome: 'completed' })
        if (scope && !recorder.overflowed) {
          await this.deps.idempotency.save(scope, {
            v: 1,
            frames: recorder.frames(),
            result: {
              tokensSettled: result.tokensSettled,
              fragments: result.fragments,
              lastEventId: result.lastEventId,
            },
          })
        }
        return
      }
      case 'aborted': {
        this.#finishSse(ctx, { outcome: 'aborted', reason: result.reason })
        return
      }
      default:
        assertNever(result, 'stream outcome')
    }
  }

  /** Re-write a cached response verbatim: same frames, same ids, zero cost. */
  #replay(ctx: HttpContext, cached: CachedAiResponse): void {
    const res = ctx.response.response
    res.setHeader('X-Ai-Idempotent-Replay', '1')
    httpStreamTarget(ctx).flushHeaders()
    try {
      for (const frame of cached.frames) {
        res.write(frame)
      }
    } catch {
      // The client vanished mid-replay; there is nothing to settle or undo.
    }
    this.#finishSse(ctx, { outcome: 'completed' })
  }

  /**
   * Terminal `done` frame + end of the raw response. Deliberately id-less so
   * it never advances the client's Last-Event-ID resume cursor, and identical
   * between a live stream and a replay. Socket errors are swallowed: past the
   * commit point the stream result is already accounted.
   */
  #finishSse(ctx: HttpContext, payload: { outcome: string; reason?: string }): void {
    const res = ctx.response.response
    try {
      res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      /* socket already gone */
    }
    try {
      res.end()
    } catch {
      /* socket already gone */
    }
  }
}

/** The interim I8 gate: a fragment over the byte bound aborts without writing it. */
export function boundedFragmentGate(fragment: StreamFragment): StreamFragment | null {
  return fragment.data.length > AI_FRAGMENT_MAX_CHARS ? null : fragment
}

/** The per-request output cap: the request's ask, clamped by the config ceiling. */
function resolveWorstCase(requested: number | undefined, ai: AiConfig | undefined): number {
  const ceiling = ai?.maxTokens ?? DEFAULT_AI_MAX_TOKENS
  return requested === undefined ? ceiling : Math.min(requested, ceiling)
}

/** Map a pre-flight failure to its pinned HTTP status (never a 500). */
function preflightStatus(error: StreamPreflightError): number {
  switch (error) {
    case 'over_budget':
      return 402
    case 'rate_limited':
      return 429
    case 'rate_limit_unavailable':
      return 503
    case 'provider_unavailable':
      return 503
    default:
      return assertNever(error, 'preflight error')
  }
}

/** The principal an idempotent replay may be shared with, or null for none. */
function resolvePrincipal(ctx: HttpContext, ai: AiConfig | undefined): string | null {
  const raw = ai?.resolvePrincipal
    ? ai.resolvePrincipal(ctx)
    : (ctx as { auth?: { user?: { id?: unknown } } }).auth?.user?.id
  if (raw === null || raw === undefined) return null
  const principal = String(raw)
  return principal.length > 0 ? principal : null
}

const MESSAGE_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant'])
const SESSION_ID_MAX_LENGTH = 200

function invalid(message: string): never {
  throw new AIException('invalid_request', message)
}

/**
 * Validate the chat body shape and bounds before any reservation or provider
 * call. Messages are required and non-empty; the combined content length is
 * bounded by `maxPromptChars`; the tunables must be well-typed. Error
 * messages name the field, never echo content (G3).
 */
function parseChatBody(raw: unknown, ai: AiConfig | undefined): ChatBody {
  if (typeof raw !== 'object' || raw === null) {
    invalid('the chat body must be a JSON object with a messages array')
  }
  const body = raw as Record<string, unknown>

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    invalid('messages must be a non-empty array')
  }
  let promptChars = 0
  const messages: AIMessage[] = body.messages.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      invalid(`messages[${index}] must be an object`)
    }
    const { role, content } = entry as Record<string, unknown>
    if (typeof role !== 'string' || !MESSAGE_ROLES.has(role)) {
      invalid(`messages[${index}].role must be one of system, user, assistant`)
    }
    if (typeof content !== 'string' || content.length === 0) {
      invalid(`messages[${index}].content must be a non-empty string`)
    }
    promptChars += content.length
    return { role: role as AIMessage['role'], content }
  })

  const maxPromptChars = ai?.maxPromptChars ?? DEFAULT_AI_MAX_PROMPT_CHARS
  if (promptChars > maxPromptChars) {
    invalid(`the combined messages content exceeds maxPromptChars (${maxPromptChars})`)
  }

  if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length === 0)) {
    invalid('model, when set, must be a non-empty string')
  }
  if (
    body.maxTokens !== undefined &&
    (typeof body.maxTokens !== 'number' || !Number.isInteger(body.maxTokens) || body.maxTokens <= 0)
  ) {
    invalid('maxTokens, when set, must be a positive integer')
  }
  if (
    body.sessionId !== undefined &&
    (typeof body.sessionId !== 'string' ||
      body.sessionId.length === 0 ||
      body.sessionId.length > SESSION_ID_MAX_LENGTH)
  ) {
    invalid(`sessionId, when set, must be a string of 1 to ${SESSION_ID_MAX_LENGTH} chars`)
  }

  return {
    messages,
    model: body.model as string | undefined,
    maxTokens: body.maxTokens as number | undefined,
    sessionId: body.sessionId as string | undefined,
  }
}
