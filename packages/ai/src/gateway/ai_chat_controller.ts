import type { HttpContext } from '@adonisjs/core/http'
import type StreamExtensionService from './stream_extension.js'
import {
  httpStreamTarget,
  type StreamResult,
  type StreamProducer,
  type EmitMetric,
} from './stream_extension.js'
import { buildToolLoopProducer, resolveMaxRounds, type ToolLoopExecutor } from './tool_loop.js'
import { advertisedTools, resolveToolRegistry } from './tool_gate.js'
import type ToolExecutorService from '../services/tool_executor.js'
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
import { enforceChatResidency, enforceEmbeddingResidency } from '../services/residency_gate.js'
import recordingStreamTarget from './recording_target.js'
import {
  buildRetrievalContext,
  injectMemoryTurns,
  reconstructAssistantText,
} from './context_builder.js'
import type ConversationMemoryService from '../services/conversation_memory_service.js'
import type { ResolvedMemorySession } from '../services/conversation_memory_service.js'
import {
  hashAuditPrincipal,
  noopAuditSink,
  noopRetrievalAuditSink,
  type AiGatewayAuditEvent,
  type AiGatewayAuditSink,
  type AiRetrievalAuditEvent,
  type AiRetrievalAuditSink,
} from './audit_seam.js'
import AIException, { httpStatusForAiCode } from '../exceptions/ai_exception.js'
import { assertNever } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type RetrievalService from '../services/retrieval_service.js'
import type { VectorMatch } from '../services/vector_store_service.js'
import type {
  AiConfig,
  AIRetrievalConfig,
  AIToolHostDefinition,
  AIToolsConfig,
  RetrievalScope,
  RedactOutput,
} from '../define_config.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type {
  AIMessage,
  AIStreamRequest,
  AIToolDefinition,
  StreamFragment,
} from '../types/ai_provider_contract.js'
import {
  AI_FRAGMENT_MAX_CHARS,
  AI_IDEMPOTENCY_MAX_BYTES,
  AI_OUTPUT_REDACTED_METRIC,
  AI_TOKENS_QUOTA,
  DEFAULT_AI_MAX_PROMPT_CHARS,
  DEFAULT_AI_MAX_TOKENS,
  DEFAULT_MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT,
  MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT,
  DEFAULT_MAX_CONTEXT_CHARS,
  DEFAULT_MAX_CONTEXT_ITEMS,
  DEFAULT_MAX_QUERY_CHARS,
  DEFAULT_MEMORY_MAX_CHARS,
  DEFAULT_MEMORY_MAX_TURNS,
  DEFAULT_RETRIEVAL_LIMIT,
  MAX_RETRIEVAL_LIMIT,
} from '../constants.js'

/** The chat request body. Everything else in the body is ignored. */
interface ChatBody {
  messages: AIMessage[]
  model?: string | undefined
  maxTokens?: number | undefined
  sessionId?: string | undefined
  /** Opt-in RAG: retrieve matches for `query` and fold them into the context as data. */
  retrieve?: { query: string; limit?: number | undefined } | undefined
}

export interface AiChatControllerDeps {
  stream: StreamExtensionService
  registry: AIProviderRegistry
  idempotency: AiIdempotencyService
  liveness: TenantLivenessWatcher
  config: AiConfig | undefined
  /**
   * Per-tenant integer metrics (satisfied by core's `MetricsService.emitMetric`).
   * Optional and best-effort; used to surface `ai_output_redacted` when a host
   * `config.ai.redactOutput` hook changed or aborted output. Defaults to a no-op.
   */
  emitMetric?: EmitMetric
  /** The per-key request rate limiter (threat #4). Default: a disabled limiter. */
  rateLimiter?: AiRateLimiter
  /**
   * The retrieval service, for opt-in RAG. Present only when the host
   * configured embeddings; absent means a `retrieve` request is a 400. Resolved
   * lazily by the route so non-RAG chat is unaffected when embeddings are off.
   */
  retrieval?: RetrievalService | undefined
  /** The attribution seam. Default: the no-op sink. */
  audit?: AiGatewayAuditSink | undefined
  /** The retrieval attribution seam (for the RAG step). Default: the no-op sink. */
  retrievalAudit?: AiRetrievalAuditSink | undefined
  /**
   * Conversation memory. Present only when the host configured
   * `config.ai.memory`; absent (or `.enabled` false) leaves chat stateless and
   * `sessionId` its opaque idempotency-scope meaning. When active, the gateway
   * mints/validates the HMAC-bound session, replays prior turns, and persists the
   * completed exchange.
   */
  memory?: ConversationMemoryService | undefined
  /**
   * The tool executor (WS-AI-11). Present only when the host configured
   * `config.ai.tools`; absent leaves chat tool-free with ZERO overhead (the
   * plain `provider.stream` closure runs byte-for-byte as before). When present
   * AND the per-tenant registry advertises at least one read tool, the request
   * runs the multi-round tool loop inside the same single pump.
   */
  tools?: ToolExecutorService | undefined
  /**
   * Structured drop/telemetry log for the tool loop (satisfied by the app
   * logger's `warn`). Used only to surface a `maxToolsPerRound` drop (never a
   * silent cap). Optional; defaults to no-op.
   */
  log?: ((message: string) => void) | undefined
}

/**
 * A resolved tool-loop plan for one request (WS-AI-11): the FULL registry the
 * executor gates a call against, the read-only subset advertised to the model,
 * and the tools config block carrying the loop bounds. Absent means plain chat.
 */
interface ToolLoopPlan {
  readonly fullSet: AIToolHostDefinition[]
  readonly advertised: AIToolDefinition[]
  readonly toolsConfig: AIToolsConfig
  readonly executor: ToolLoopExecutor
}

/**
 * The single choke point: every model call flows through `chat`, in
 * the ARCHITECTURE.md sequence order, which is deliberate: authorization
 * first (a denied caller spends nothing), reserve before the provider call
 * (inside the streaming spine), settle/release in its finally, and the
 * response idempotency-cached only when it completed.
 *
 * All dependencies are container singletons resolved by the route closure and
 * injected here, so this module never value-imports the eager core barrels
 * and unit-tests with doubles. Instantiated per request (it is stateless).
 *
 * ContextSeal constraint (a kernel guarantee, doc-level here): no code below runs
 * a tenant-scoped model query. When retrieval runs inside the stream, that query
 * MUST run under this request's own tenant scope, or the kernel's ContextSeal
 * refuses it with a typed 500.
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
        await this.#auditSafe({
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

    // 5-residency. Data residency / no-train (#7/#15): the tenant posture may
    //    refuse this provider (a 403 `residency_denied`), before any reservation
    //    or rate-limit hit. Like the access gate, it propagates.
    await enforceChatResidency(tenant, provider.name, ai)

    // Attribution base, shared by the RAG-preflight failure paths and the
    // stream-resolution switch. Preflight failures leave headers unsent (the
    // spine's commit-point contract), so a real status still applies.
    const auditBase = {
      tenantId: tenant.id,
      principalHash,
      provider: provider.name as string | null,
      model: body.model ?? null,
      idempotentReplay: false,
    }

    // 5a. Conversation memory session, pre-cost. When memory is
    //     enabled AND a principal is resolvable, a supplied sessionId is validated
    //     (a forged token 400s HERE, before any reservation, via the shared
    //     preflight path) and an absent one mints a new server-owned session whose
    //     token is handed back on X-Ai-Session. Without a principal memory is inert
    //     (the ai_memory doctor check warns), and a mint writes nothing until a
    //     turn completes, so a never-finished request leaves zero Redis state.
    const memory = this.deps.memory
    let memorySession: ResolvedMemorySession | undefined
    let mintedSessionToken: string | undefined
    // The memory-view snapshot time: a purge that lands after this
    // instant tombstones the session, and the late `append` below is dropped so
    // an in-flight turn cannot resurrect just-erased history.
    let memorySnapshotAt: number | undefined
    if (memory?.enabled && principal !== null) {
      memorySnapshotAt = Date.now()
      try {
        if (body.sessionId !== undefined) {
          memorySession = memory.resolveSession(body.sessionId, tenant.id, principal)
        } else {
          const minted = memory.mintSession(tenant.id, principal)
          memorySession = { storageKey: minted.storageKey }
          mintedSessionToken = minted.token
        }
      } catch (error) {
        if (await this.#failChatPreflight(ctx, auditBase, error)) return
        throw error
      }
    }

    // 5b. Document-ACL preflight, BEFORE the rate limiter so a RAG
    //     request refused by the per-user ACL (or the fail-closed default)
    //     spends nothing, matching /ai/retrieve (a refused caller must not burn a
    //     rate-limit hit). Only the cheap authorization resolves here; the metered
    //     query embed stays after the limiter (6a).
    let retrievalScope: RetrievalScope | undefined
    try {
      retrievalScope = await this.#retrievePreflight(ctx, tenant, body, ai, principalHash)
    } catch (error) {
      if (await this.#failChatPreflight(ctx, auditBase, error)) return
      throw error
    }

    // 5c. Per-key request rate limit (threat #4), pre-flight so a 429/503 lands
    //     before any reservation or byte. A replay already returned above, so a
    //     cached response never consumes the provider key's rate budget. Wrapped
    //     like the reserve/retrieval preflights so a refusal returns the pinned
    //     `{ error: <code> }` body (e.g. `rate_limited`) and is audited, instead of
    //     escaping to the framework's default exception renderer.
    try {
      await (this.deps.rateLimiter ?? DISABLED_AI_RATE_LIMITER).check({
        op: 'chat',
        tenantId: tenant.id,
        fingerprint: provider.keyFingerprint ?? provider.name,
      })
    } catch (error) {
      if (await this.#failChatPreflight(ctx, auditBase, error)) return
      throw error
    }

    // 5d. Tool-loop planning (WS-AI-11). Only when the host opted into tools AND
    //     the executor is wired (the route injects it solely then), so a non-tool
    //     chat pays ZERO overhead. Resolve the per-tenant registry behind the
    //     default-deny gate; when it advertises at least one read tool this request
    //     becomes a multi-round tool loop, and the per-request executor is bound
    //     now (cheap, side-effect-free). A `resolveTools` throw is a fail-closed
    //     preflight refusal (before any byte), mapped to its pinned status like the
    //     other preflights.
    let toolPlan: ToolLoopPlan | undefined
    if (this.deps.tools && ai?.tools) {
      try {
        const fullSet = await resolveToolRegistry(ctx, tenant, ai.tools)
        const advertised = advertisedTools(fullSet)
        if (advertised.length > 0) {
          // Phase 0's conditionally-required capability: a tool loop against a
          // provider that does not declare `capabilities.tools` fails CLOSED
          // (403 provider_not_allowed), rather than advertising tools the provider
          // will silently drop and answering as if tool calling were unavailable.
          if (provider.capabilities.tools !== true) {
            throw new AIException(
              'provider_not_allowed',
              'the selected provider does not support tool calling'
            )
          }
          toolPlan = {
            fullSet,
            advertised,
            toolsConfig: ai.tools,
            executor: this.deps.tools.forRequest(ctx, tenant, fullSet, principalHash),
          }
        }
      } catch (error) {
        if (await this.#failChatPreflight(ctx, auditBase, error)) return
        throw error
      }
    }

    // 6. The stream itself: the liveness handle (also covering the RAG query
    //    embed), a recording tee for the idempotency cache, the spine for the rest.
    //    A tool loop is admitted only under the per-tenant in-flight cap (Phase
    //    2a): the (N+1)th concurrent stream is refused pre-commit with a 429
    //    `too_many_concurrent`, so a flood of expensive multi-round loops cannot
    //    starve the connection pool. Plain chat acquires uncapped and never throws.
    let liveness: { signal: AbortSignal; dispose: () => void }
    try {
      liveness = this.deps.liveness.acquire(
        tenant.id,
        toolPlan ? { maxConcurrent: resolveMaxConcurrent(toolPlan.toolsConfig) } : {}
      )
    } catch (error) {
      if (await this.#failChatPreflight(ctx, auditBase, error)) return
      throw error
    }
    const recorder = recordingStreamTarget(httpStreamTarget(ctx), {
      maxBytes: AI_IDEMPOTENCY_MAX_BYTES,
    })
    // The optional host output-redaction hook composes with the mandatory output
    // bound; because it runs at the single fragment choke point (upstream of the
    // recording tee), the redacted bytes are what the client, the idempotency
    // cache, and conversation memory all see.
    const redactionStats: RedactionStats = { redactions: 0 }
    const fragmentGate = composeRedactionGate(
      boundedFragmentGate,
      ai?.redactOutput,
      ctx,
      tenant,
      redactionStats
    )
    let result: StreamResult
    try {
      // 6a. RAG augmentation, on a cache MISS only: run the metered
      //     query embed + scoped search under the ALREADY-resolved document ACL
      //     (5a), and fold the fenced matches into the context as untrusted
      //     user-role DATA (#10), bounded so the ASSEMBLED prompt stays within
      //     maxPromptChars (#8). A retrieval failure (over budget, embed error)
      //     fails the request BEFORE the stream commits, with the pinned status.
      let messages: AIMessage[]
      try {
        messages = await this.#applyRetrieval(
          tenant,
          body,
          ai,
          principalHash,
          retrievalScope,
          liveness.signal
        )
      } catch (error) {
        if (await this.#failChatPreflight(ctx, auditBase, error)) return
        throw error
      }

      // 6b. Conversation memory replay. Load the session's prior
      //     turns (a store/decrypt failure degrades to none, never fails the chat)
      //     and prepend them AFTER retrieval, bounded to the budget left under
      //     maxPromptChars so the assembled prompt stays within it (#2/#8).
      if (memory && memorySession) {
        const prior = await memory.load(tenant.id, memorySession.storageKey)
        messages = injectMemoryTurns(messages, prior, resolveMemoryBudget(messages, ai))
      }

      // Hand the freshly minted session token back only once the request is about
      // to stream: a preflight failure above never emits it, so the token maps
      // solely to a session a turn actually reached.
      if (mintedSessionToken) ctx.response.response.setHeader('X-Ai-Session', mintedSessionToken)

      const request: AIStreamRequest = { messages, model: body.model, maxTokens: worstCase }

      // The producer + reservation. A tool request runs the multi-round loop
      // INSIDE this same single pump (one reservation = perRound × maxRounds, one
      // commit, monotonic ids, aggregated StreamResult), so the aggregate budget
      // is enforced for free by the pipeline's `budgetExhausted` at that worst
      // case. A plain chat keeps the byte-for-byte provider.stream closure and the
      // single per-request reservation.
      let produce: StreamProducer = (signal) => provider.stream(request, signal)
      let reservationWorstCase = worstCase
      if (toolPlan) {
        const maxRounds = resolveMaxRounds(toolPlan.toolsConfig.maxRounds)
        reservationWorstCase = worstCase * maxRounds
        produce = buildToolLoopProducer({
          tenantId: tenant.id,
          provider,
          baseRequest: request,
          tools: toolPlan.advertised,
          executor: toolPlan.executor,
          perRoundMaxTokens: worstCase,
          maxRounds,
          maxToolsPerRound: toolPlan.toolsConfig.maxToolsPerRound,
          maxToolCallsPerRequest: toolPlan.toolsConfig.maxToolCallsPerRequest,
          surfaceToolArgs: toolPlan.toolsConfig.surfaceToolArgs,
          // Invariant 2 (per-round rate limit): rounds >= 2 consult the limiter so
          // the denial-of-wallet rail counts every upstream call. A denial throws
          // an AIException; headers are already flushed, so the spine renders it as
          // an in-band `event: error` frame and the last text stands.
          onBeforeRound: async () => {
            await (this.deps.rateLimiter ?? DISABLED_AI_RATE_LIMITER).check({
              op: 'chat',
              tenantId: tenant.id,
              fingerprint: provider.keyFingerprint ?? provider.name,
            })
          },
          log: this.deps.log,
          emitMetric: this.deps.emitMetric,
        })
      }

      result = await this.deps.stream.stream(recorder.target, produce, {
        label: 'ai:chat',
        tenant,
        quota: AI_TOKENS_QUOTA,
        worstCase: reservationWorstCase,
        timeoutMs: ai?.timeoutMs,
        heartbeatMs: ai?.heartbeatMs,
        lastEventId: ctx.request.header('last-event-id'),
        livenessSignal: liveness.signal,
        validateFragment: fragmentGate,
        provider: provider.name,
        model: body.model,
      })
    } finally {
      liveness.dispose()
    }

    // Best-effort, content-free: how many fragments the host redactor changed or
    // aborted. The hook is host policy (defense-in-depth), never the isolation
    // control, so this is observability, not a guard trip.
    if (redactionStats.redactions > 0) {
      try {
        this.deps.emitMetric?.(tenant.id, AI_OUTPUT_REDACTED_METRIC, redactionStats.redactions)
      } catch {
        /* metrics are best-effort */
      }
    }

    // 7. Resolution. Committed outcomes end the SSE stream with a terminal `done`
    //    frame. Every path lands one attribution event on the audit seam.
    switch (result.outcome) {
      case 'failed_preflight': {
        ctx.response.status(httpStatusForAiCode(result.error)).send({ error: result.error })
        await this.#auditSafe({
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
            // Carry the minted token so a turn-1 replay re-emits X-Ai-Session (gap A).
            sessionToken: mintedSessionToken,
          })
        }
        // Persist the completed exchange (WS-AI-4). Gated on !overflowed so the
        // frames are complete; best-effort inside `append`, so it never fails an
        // already-sent response.
        if (memory && memorySession && !recorder.overflowed) {
          await this.#persistMemory(
            tenant.id,
            memorySession.storageKey,
            body,
            recorder.frames(),
            memorySnapshotAt
          )
        }
        await this.#auditSafe({
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
        await this.#auditSafe({
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
   * Chat attribution is best-effort by physical necessity: every chat audit fires
   * after the stream is committed (completed / aborted / replay) or on a failure
   * whose status is already sent (failed_preflight). A completed SSE stream cannot
   * be un-sent, so a fail-closed throw here would only be noise on an ended
   * response. Fail-closed is preserved another way: on a write outage the writer
   * trips `guard.ai_audit_write_failed` (observable) and the row it could not write
   * is a detectable `seq` gap that `tenant:ai:audit:verify` reports. So the sink's
   * throw is swallowed, never the guard.
   */
  async #auditSafe(event: AiGatewayAuditEvent): Promise<void> {
    try {
      await this.#audit().append(event)
    } catch {
      /* guard.ai_audit_write_failed tripped by the writer; the seq gap remains */
    }
  }

  async #retrievalAuditSafe(event: AiRetrievalAuditEvent): Promise<void> {
    try {
      await this.#retrievalAudit().append(event)
    } catch {
      /* guard.ai_audit_write_failed tripped by the writer; the seq gap remains */
    }
  }

  /**
   * The document-ACL preflight (WS-AI-5, G2): resolve the per-user retrieval scope
   * BEFORE the rate limiter and any cost, so a RAG request refused by the ACL (or
   * the fail-closed default) spends nothing, matching /ai/retrieve. Returns
   * `undefined` when there is no `retrieve` ask (plain chat). A `retrieve` ask with
   * no retrieval service (embeddings unconfigured) is a 400; a denied ACL is a 403
   * `retrieval_denied`, audited `failed_preflight` and rethrown so the caller can
   * fail the request before the stream (and before the rate-limit hit) commits.
   */
  async #retrievePreflight(
    ctx: HttpContext,
    tenant: TenantModelContract,
    body: ChatBody,
    ai: AiConfig | undefined,
    principalHash: string | null
  ): Promise<RetrievalScope | undefined> {
    if (!body.retrieve) return undefined
    if (!this.deps.retrieval) {
      throw new AIException(
        'invalid_request',
        'retrieval requested but embeddings are not configured'
      )
    }
    try {
      // The RAG query embed is a remote egress too: enforce residency before it,
      // audited as a preflight failure if refused (E7).
      await enforceEmbeddingResidency(tenant, ai)
      return await resolveRetrievalScope(ctx, tenant, ai)
    } catch (error) {
      await this.#retrievalAuditSafe({
        tenantId: tenant.id,
        actorHash: principalHash,
        model: null,
        matchCount: 0,
        tokens: 0,
        outcome: 'failed_preflight',
        reason: error instanceof AIException ? error.aiCode : 'error',
        occurredAt: new Date().toISOString(),
      })
      throw error
    }
  }

  /**
   * Apply the retrieval to the messages (WS-AI-5), AFTER the rate limiter so the
   * metered query embed is rate-gated. Runs the embed + scoped search under the
   * ALREADY-resolved `scope`, folds the fenced matches into the messages as
   * untrusted user-role DATA (#10) bounded to keep the assembled prompt within
   * `maxPromptChars` (#8), and attributes the retrieval op (non-PII). Without a
   * `retrieve` ask (scope `undefined`) the messages pass through unchanged. Any
   * retrieval failure is audited `failed_preflight` and rethrown.
   */
  async #applyRetrieval(
    tenant: TenantModelContract,
    body: ChatBody,
    ai: AiConfig | undefined,
    principalHash: string | null,
    scope: RetrievalScope | undefined,
    signal: AbortSignal
  ): Promise<AIMessage[]> {
    if (!body.retrieve || scope === undefined || !this.deps.retrieval) return body.messages
    const retrieval = this.deps.retrieval

    const retrievalBase = { tenantId: tenant.id, actorHash: principalHash }
    try {
      const limit = resolveRetrieveLimit(body.retrieve.limit, ai?.retrieval)
      const result = await retrieval.retrieve(
        tenant,
        { query: body.retrieve.query, limit, scope },
        signal
      )
      await this.#retrievalAuditSafe({
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
      await this.#retrievalAuditSafe({
        ...retrievalBase,
        model: null,
        matchCount: 0,
        tokens: 0,
        outcome: 'failed_preflight',
        reason: error instanceof AIException ? error.aiCode : 'error',
        occurredAt: new Date().toISOString(),
      })
      throw error
    }
  }

  /**
   * Map a chat pre-flight AIException to its pinned HTTP status + a
   * `failed_preflight` chat audit event, returning true when handled (so the
   * caller returns). A non-AIException returns false so the caller rethrows.
   * Shared by the document-ACL preflight (5a) and the retrieval-apply step (6a).
   */
  async #failChatPreflight(
    ctx: HttpContext,
    auditBase: {
      tenantId: string
      principalHash: string | null
      provider: string | null
      model: string | null
      idempotentReplay: boolean
    },
    error: unknown
  ): Promise<boolean> {
    if (!(error instanceof AIException)) return false
    ctx.response.status(error.httpStatus).send({ error: error.aiCode })
    await this.#auditSafe({
      ...auditBase,
      outcome: 'failed_preflight',
      reason: error.aiCode,
      tokensSettled: 0,
      fragments: 0,
      occurredAt: new Date().toISOString(),
    })
    return true
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
    // Re-emit the minted session (WS-AI-4, gap A): a client whose turn-1 dropped
    // after the mint learns its session on replay instead of re-minting an empty one.
    if (cached.sessionToken) res.setHeader('X-Ai-Session', cached.sessionToken)
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
   * Persist the completed exchange to conversation memory (WS-AI-4). Stores the
   * request's last `user` turn (its actual question, not an injected memory or
   * retrieval block) paired with the reconstructed assistant answer. Skips when
   * there is no user turn or the answer is empty; `append` itself is best-effort,
   * so this never throws into an already-sent response.
   */
  async #persistMemory(
    tenantId: string,
    storageKey: string,
    body: ChatBody,
    frames: readonly string[],
    snapshotAt?: number
  ): Promise<void> {
    const memory = this.deps.memory
    if (!memory) return
    const user = lastUserContent(body.messages)
    if (user === null) return
    const assistant = reconstructAssistantText(frames)
    if (assistant.length === 0) return
    await memory.append(tenantId, storageKey, { user, assistant }, snapshotAt)
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

/** A mutable per-stream redaction counter the composed gate bumps; read once to emit the metric. */
export interface RedactionStats {
  redactions: number
}

/**
 * Compose the mandatory I8 output bound with an optional host `redactOutput`
 * hook. The bound always applies FIRST and LAST, so I8 holds even against a
 * misbehaving host hook (one that expands a chunk past the bound); the redactor
 * sits between as host-owned defense-in-depth, NEVER the isolation control (I4/I8
 * are the guarantee). Fail-closed: a redactor that throws, or returns a
 * non-string, aborts the stream (returns null) rather than emitting unredacted
 * bytes. A `null` return is a deliberate host abort. `tokens` is preserved (the
 * provider generated them; redacting the display does not refund provider cost).
 * The redacted fragment is what the writer emits, so the recording tee captures
 * it and the idempotency cache + conversation memory store the redacted bytes.
 */
export function composeRedactionGate(
  bound: (fragment: StreamFragment) => StreamFragment | null,
  redactOutput: RedactOutput | undefined,
  ctx: HttpContext,
  tenant: TenantModelContract,
  stats: RedactionStats
): (fragment: StreamFragment) => StreamFragment | null {
  if (!redactOutput) return bound
  return (fragment) => {
    const bounded = bound(fragment)
    if (bounded === null) return null
    let out: string | null
    try {
      out = redactOutput(ctx, tenant, bounded.data)
    } catch {
      // Fail-closed: a throwing redactor aborts, never emits unredacted bytes.
      stats.redactions += 1
      return null
    }
    if (out === null || typeof out !== 'string') {
      // A deliberate abort, or a defensive treat-non-string-as-abort.
      stats.redactions += 1
      return null
    }
    if (out === bounded.data) return bounded // unchanged: not a redaction
    stats.redactions += 1
    // Re-apply the mandatory bound to the redacted text so I8 holds even if the
    // hook expanded the chunk. Keep tokens (provider cost is unchanged).
    return bound({ ...bounded, data: out })
  }
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
  const n = Number.parseInt(match[1]!, 10)
  return Number.isInteger(n) ? n : null
}

/** The per-request output cap: the request's ask, clamped by the config ceiling. */
function resolveWorstCase(requested: number | undefined, ai: AiConfig | undefined): number {
  const ceiling = ai?.maxTokens ?? DEFAULT_AI_MAX_TOKENS
  return requested === undefined ? ceiling : Math.min(requested, ceiling)
}

/**
 * The per-tenant in-flight admission cap for a tool loop (Phase 2a): the config
 * value clamped to the hard ceiling, defaulting when unset or malformed. Matches
 * the clamp discipline the loop/executor apply to their own bounds, and is only
 * ever consumed here (the liveness watcher receives an already-validated cap).
 */
function resolveMaxConcurrent(toolsConfig: AIToolsConfig): number {
  const value = toolsConfig.maxConcurrentPerTenant
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return Math.min(
      DEFAULT_MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT,
      MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT
    )
  }
  return Math.min(value, MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT)
}

/**
 * The memory block's effective budget: its configured turn cap, and a char cap
 * that is the smaller of `config.ai.memory.maxChars` and what remains of
 * `maxPromptChars` after the ALREADY-assembled messages (the current turn plus
 * any retrieval block). Injecting memory last, within this remainder, keeps the
 * assembled prompt inside `maxPromptChars` (#2/#8); retrieval keeps priority.
 */
function resolveMemoryBudget(
  messages: AIMessage[],
  ai: AiConfig | undefined
): { maxTurns: number; maxChars: number } {
  const maxPromptChars = ai?.maxPromptChars ?? DEFAULT_AI_MAX_PROMPT_CHARS
  const assembled = messages.reduce((total, message) => total + message.content.length, 0)
  const remaining = Math.max(0, maxPromptChars - assembled)
  const configured = ai?.memory?.maxChars ?? DEFAULT_MEMORY_MAX_CHARS
  return {
    maxTurns: ai?.memory?.maxTurns ?? DEFAULT_MEMORY_MAX_TURNS,
    maxChars: Math.min(configured, remaining),
  }
}

/** The content of the last `user`-role message, or null when there is none to remember. */
function lastUserContent(messages: AIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') return message.content
  }
  return null
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
  return [...messages.slice(0, -1), block, messages[messages.length - 1]!]
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
 *
 * Tool-calling front door (WS-AI-11): `role` is checked against `MESSAGE_ROLES`
 * (`system|user|assistant`) and `content` must be a non-empty string, and only
 * those two keys are read. So a client can never submit an `assistant.toolCalls`
 * turn or a `role: 'tool'` result: every tool turn is server-authored mid-loop,
 * which structurally closes the forged-tool-result / confused-deputy surface here
 * rather than relying on a downstream check.
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
