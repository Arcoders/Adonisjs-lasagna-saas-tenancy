import type { HttpContext } from '@adonisjs/core/http'
import type StreamExtensionService from './stream_extension.js'
import { httpStreamTarget, type StreamResult } from './stream_extension.js'
import type AIProviderRegistry from '../services/ai_provider_registry.js'
import type TenantLivenessWatcher from '../services/tenant_liveness_watcher.js'
import type AiRateLimiter from '../services/ai_rate_limiter.js'
import { DISABLED_AI_RATE_LIMITER } from '../services/ai_rate_limiter.js'
import type AiIdempotencyService from './idempotency.js'
import {
  validateIdempotencyKeyHeader,
  type AiIdempotencyScope,
  type CachedAiResponse,
} from './idempotency.js'
import { authorizeAiAccess, resolveRequestTenant, resolveRetrievalScope } from './access_gate.js'
import recordingStreamTarget from './recording_target.js'
import { buildRetrievalContext } from './context_builder.js'
import {
  hashAuditPrincipal,
  noopAuditSink,
  noopRetrievalAuditSink,
  type AiGatewayAuditSink,
  type AiRetrievalAuditSink,
} from './audit_seam.js'
import AIException, { httpStatusForAiCode } from '../exceptions/ai_exception.js'
import { assertNever } from '../internal/assert_never.js'
import type RetrievalService from '../services/retrieval_service.js'
import type { VectorMatch } from '../services/vector_store_service.js'
import type { AiConfig, AIRetrievalConfig } from '../define_config.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { AIMessage, AIStreamRequest, StreamFragment } from '../types/ai_provider_contract.js'
import {
  AI_FRAGMENT_MAX_CHARS,
  AI_IDEMPOTENCY_MAX_BYTES,
  AI_TOKENS_QUOTA,
  DEFAULT_AI_MAX_PROMPT_CHARS,
  DEFAULT_AI_MAX_TOKENS,
  DEFAULT_MAX_CONTEXT_CHARS,
  DEFAULT_MAX_CONTEXT_ITEMS,
  DEFAULT_MAX_QUERY_CHARS,
  DEFAULT_RETRIEVAL_LIMIT,
  MAX_RETRIEVAL_LIMIT,
} from '../constants.js'

/** The chat request body. Everything else in the body is ignored. */
interface ChatBody {
  messages: AIMessage[]
  model?: string
  maxTokens?: number
  sessionId?: string
  /** Opt-in RAG (WS-AI-5): retrieve matches for `query` and fold them into the context as data. */
  retrieve?: { query: string; limit?: number }
}

export interface AiChatControllerDeps {
  stream: StreamExtensionService
  registry: AIProviderRegistry
  idempotency: AiIdempotencyService
  liveness: TenantLivenessWatcher
  config: AiConfig | undefined
  /** The per-key request rate limiter (threat #4). Default: a disabled limiter. */
  rateLimiter?: AiRateLimiter
  /**
   * The retrieval service (WS-AI-5), for opt-in RAG. Present only when the host
   * configured embeddings; absent means a `retrieve` request is a 400. Resolved
   * lazily by the route so non-RAG chat is unaffected when embeddings are off.
   */
  retrieval?: RetrievalService
  /** The WS-AI-7 attribution seam. Default: the no-op sink. */
  audit?: AiGatewayAuditSink
  /** The WS-AI-7 retrieval attribution seam (for the RAG step). Default: the no-op sink. */
  retrievalAudit?: AiRetrievalAuditSink
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
    const principal = resolvePrincipal(ctx, ai)
    const principalHash = hashAuditPrincipal(principal)
    const headerKey = ctx.request.header('idempotency-key')
    let scope: AiIdempotencyScope | null = null
    if (headerKey !== undefined) {
      const validated = validateIdempotencyKeyHeader(headerKey, tenant.id)
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
        this.#replay(ctx, cached, ctx.request.header('last-event-id'))
        await this.#audit().append({
          tenantId: tenant.id,
          principalHash,
          provider: null,
          model: body.model ?? null,
          outcome: 'completed',
          reason: null,
          tokensSettled: cached.result.tokensSettled,
          fragments: cached.result.fragments,
          idempotentReplay: true,
          occurredAt: new Date().toISOString(),
        })
        return
      }
    }

    // 5. Provider selection (default-deny; AIException statuses propagate:
    //    403 provider_not_allowed / 503 provider_unavailable / 500 config_missing).
    const provider = this.deps.registry.forTenant(tenant, ai)

    // 5b. Per-key request rate limit (threat #4), pre-flight so a 429/503 lands
    //     before any reservation or byte. A replay already returned above, so a
    //     cached response never consumes the provider key's rate budget.
    await (this.deps.rateLimiter ?? DISABLED_AI_RATE_LIMITER).check({
      op: 'chat',
      tenantId: tenant.id,
      fingerprint: provider.keyFingerprint ?? provider.name,
    })

    // Attribution base, shared by the RAG-preflight failure path and the
    // stream-resolution switch. Preflight failures leave headers unsent (the
    // spine's commit-point contract), so a real status still applies.
    const auditBase = {
      tenantId: tenant.id,
      principalHash,
      provider: provider.name as string | null,
      model: body.model ?? null,
      idempotentReplay: false,
    }

    // 6. The stream itself: liveness handle for G11 (also covering the RAG query
    //    embed), a recording tee for the idempotency cache, the spine for the rest.
    const liveness = this.deps.liveness.acquire(tenant.id)
    const recorder = recordingStreamTarget(httpStreamTarget(ctx), {
      maxBytes: AI_IDEMPOTENCY_MAX_BYTES,
    })
    let result: StreamResult
    try {
      // 6a. RAG augmentation (WS-AI-5), on a cache MISS only: embed the query,
      //     search under the document ACL, and fold the fenced matches into the
      //     context as untrusted user-role DATA (#10), bounded so the ASSEMBLED
      //     prompt stays within maxPromptChars (#8). A retrieval preflight failure
      //     (denied ACL, over budget, embeddings unconfigured) fails the request
      //     BEFORE the stream commits, with the code's pinned status.
      let messages: AIMessage[]
      try {
        messages = await this.#augmentMessages(
          ctx,
          tenant,
          body,
          ai,
          principalHash,
          liveness.signal
        )
      } catch (error) {
        if (error instanceof AIException) {
          ctx.response.status(error.httpStatus).send({ error: error.aiCode })
          await this.#audit().append({
            ...auditBase,
            outcome: 'failed_preflight',
            reason: error.aiCode,
            tokensSettled: 0,
            fragments: 0,
            occurredAt: new Date().toISOString(),
          })
          return
        }
        throw error
      }

      const request: AIStreamRequest = { messages, model: body.model, maxTokens: worstCase }
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

    // 7. Resolution. Committed outcomes end the SSE stream with a terminal `done`
    //    frame. Every path lands one attribution event on the audit seam.
    switch (result.outcome) {
      case 'failed_preflight': {
        ctx.response.status(httpStatusForAiCode(result.error)).send({ error: result.error })
        await this.#audit().append({
          ...auditBase,
          outcome: 'failed_preflight',
          reason: result.error,
          tokensSettled: 0,
          fragments: 0,
          occurredAt: new Date().toISOString(),
        })
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
        await this.#audit().append({
          ...auditBase,
          outcome: 'completed',
          reason: null,
          tokensSettled: result.tokensSettled,
          fragments: result.fragments,
          occurredAt: new Date().toISOString(),
        })
        return
      }
      case 'aborted': {
        this.#finishSse(ctx, { outcome: 'aborted', reason: result.reason })
        await this.#audit().append({
          ...auditBase,
          outcome: 'aborted',
          reason: result.reason,
          tokensSettled: result.tokensSettled,
          fragments: result.fragments,
          occurredAt: new Date().toISOString(),
        })
        return
      }
      default:
        assertNever(result, 'stream outcome')
    }
  }

  #audit(): AiGatewayAuditSink {
    return this.deps.audit ?? noopAuditSink
  }

  #retrievalAudit(): AiRetrievalAuditSink {
    return this.deps.retrievalAudit ?? noopRetrievalAuditSink
  }

  /**
   * The RAG augmentation step (WS-AI-5). Without a `retrieve` ask, the messages
   * pass through unchanged. Otherwise it resolves the per-user document ACL (G2),
   * runs the metered query embed + scoped search, folds the fenced matches into
   * the messages as untrusted user-role DATA (#10) bounded to keep the assembled
   * prompt within `maxPromptChars` (#8), and attributes the retrieval op (non-PII).
   * A `retrieve` request with no retrieval service (embeddings unconfigured) is a
   * 400. Any retrieval failure is audited `failed_preflight` and rethrown so the
   * caller can fail the request before the stream commits.
   */
  async #augmentMessages(
    ctx: HttpContext,
    tenant: TenantModelContract,
    body: ChatBody,
    ai: AiConfig | undefined,
    principalHash: string | null,
    signal: AbortSignal
  ): Promise<AIMessage[]> {
    if (!body.retrieve) return body.messages
    if (!this.deps.retrieval) {
      throw new AIException(
        'invalid_request',
        'retrieval requested but embeddings are not configured'
      )
    }

    const retrievalBase = { tenantId: tenant.id, actorHash: principalHash }
    try {
      const scope = await resolveRetrievalScope(ctx, tenant, ai)
      const limit = resolveRetrieveLimit(body.retrieve.limit, ai?.retrieval)
      const result = await this.deps.retrieval.retrieve(
        tenant,
        { query: body.retrieve.query, limit, scope },
        signal
      )
      await this.#retrievalAudit().append({
        ...retrievalBase,
        model: result.model,
        matchCount: result.matches.length,
        tokens: result.tokens,
        outcome: 'completed',
        reason: null,
        occurredAt: new Date().toISOString(),
      })
      return injectRetrievedContext(body.messages, result.matches, ai)
    } catch (error) {
      const code = error instanceof AIException ? error.aiCode : null
      await this.#retrievalAudit().append({
        ...retrievalBase,
        model: null,
        matchCount: 0,
        tokens: 0,
        outcome: 'failed_preflight',
        reason: code ?? 'error',
        occurredAt: new Date().toISOString(),
      })
      throw error
    }
  }

  /**
   * Re-write a cached response verbatim: same frames, same ids, zero cost.
   * When the retry carries a `Last-Event-ID` (an SSE client reconnecting after
   * a partial receipt, with its library re-sending the same Idempotency-Key),
   * frames the client already processed are skipped, honoring the SSE resume
   * contract instead of double-delivering them.
   */
  #replay(ctx: HttpContext, cached: CachedAiResponse, lastEventId: string | undefined): void {
    const res = ctx.response.response
    res.setHeader('X-Ai-Idempotent-Replay', '1')
    httpStreamTarget(ctx).flushHeaders()
    const cursor = parseReplayCursor(lastEventId)
    try {
      for (const frame of cached.frames) {
        if (cursor !== null) {
          const id = parseFrameId(frame)
          if (id !== null && id <= cursor) continue
        }
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

/** The client's resume cursor, or null when absent or non-numeric (replay everything). */
function parseReplayCursor(lastEventId: string | undefined): number | null {
  if (lastEventId === undefined) return null
  const n = Number.parseInt(lastEventId, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** The numeric id a cached SSE frame was stamped with, or null (never skip it). */
function parseFrameId(frame: string): number | null {
  const match = /^id: (\d+)\n/.exec(frame)
  if (!match) return null
  const n = Number.parseInt(match[1], 10)
  return Number.isInteger(n) ? n : null
}

/** The per-request output cap: the request's ask, clamped by the config ceiling. */
function resolveWorstCase(requested: number | undefined, ai: AiConfig | undefined): number {
  const ceiling = ai?.maxTokens ?? DEFAULT_AI_MAX_TOKENS
  return requested === undefined ? ceiling : Math.min(requested, ceiling)
}

/** The RAG match count: the request's ask, clamped by maxLimit, defaulting to defaultLimit. */
function resolveRetrieveLimit(
  requested: number | undefined,
  retrieval: AIRetrievalConfig | undefined
): number {
  const maxLimit = retrieval?.maxLimit ?? MAX_RETRIEVAL_LIMIT
  const fallback = retrieval?.defaultLimit ?? DEFAULT_RETRIEVAL_LIMIT
  return requested === undefined ? fallback : Math.min(requested, maxLimit)
}

/**
 * Fold retrieved matches into the messages as a fenced, bounded, user-role DATA
 * block (#10, #8), inserted right before the final message (the user's question)
 * so the model reads the context adjacent to the ask. The block's character
 * budget is what remains of `maxPromptChars` after the existing messages, capped
 * by `maxContextChars`, so the ASSEMBLED prompt can never exceed `maxPromptChars`
 * (the pre-retrieval bound was checked in parseChatBody). When nothing fits (no
 * matches, or no budget), the messages pass through unchanged.
 */
function injectRetrievedContext(
  messages: AIMessage[],
  matches: readonly VectorMatch[],
  ai: AiConfig | undefined
): AIMessage[] {
  const maxPromptChars = ai?.maxPromptChars ?? DEFAULT_AI_MAX_PROMPT_CHARS
  const retrieval = ai?.retrieval
  const maxItems = retrieval?.maxContextItems ?? DEFAULT_MAX_CONTEXT_ITEMS
  const existingChars = messages.reduce((total, message) => total + message.content.length, 0)
  const budget = Math.max(0, maxPromptChars - existingChars)
  const maxChars = Math.min(retrieval?.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS, budget)

  const block = buildRetrievalContext(matches, { maxItems, maxChars })
  if (!block) return messages
  if (messages.length === 0) return [block]
  return [...messages.slice(0, -1), block, messages[messages.length - 1]]
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

  let retrieve: ChatBody['retrieve']
  if (body.retrieve !== undefined) {
    if (typeof body.retrieve !== 'object' || body.retrieve === null) {
      invalid('retrieve, when set, must be an object { query, limit? }')
    }
    const r = body.retrieve as Record<string, unknown>
    if (typeof r.query !== 'string' || r.query.length === 0) {
      invalid('retrieve.query must be a non-empty string')
    }
    const maxQueryChars = ai?.retrieval?.maxQueryChars ?? DEFAULT_MAX_QUERY_CHARS
    if (r.query.length > maxQueryChars) {
      invalid(`retrieve.query must be at most ${maxQueryChars} characters`)
    }
    if (
      r.limit !== undefined &&
      (typeof r.limit !== 'number' || !Number.isInteger(r.limit) || r.limit <= 0)
    ) {
      invalid('retrieve.limit, when set, must be a positive integer')
    }
    retrieve = { query: r.query, limit: r.limit as number | undefined }
  }

  return {
    messages,
    model: body.model as string | undefined,
    maxTokens: body.maxTokens as number | undefined,
    sessionId: body.sessionId as string | undefined,
    retrieve,
  }
}
