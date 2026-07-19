import type { HttpContext } from '@adonisjs/core/http'
import type {
  MultitenancyConfig,
  TenantAccessAuthorizer,
  TenantModelContract,
} from '@adonisjs-lasagna/saas-tenancy/types'
import type { FailurePolicy } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AIToolDefinition } from './types/ai_provider_contract.js'

/**
 * The shipped AI provider names. `(string & {})` keeps autocomplete for the
 * built-ins while admitting a custom / BYOK provider a host registers on the
 * `AIProviderRegistry`. Owned by the AI satellite (not core) so core's frozen
 * public type stays free of satellite-specific shapes. Mirrors billing's
 * `BillingDriverChoice`.
 */
export type AIProviderName = 'claude' | 'deepseek' | 'kimi' | (string & {})

/**
 * Per-provider configuration block. The key is read from the environment by the
 * host (never hardcoded); `baseUrl` is the BYOK / self-host override (validated
 * against the SSRF guard before use); `defaultModel` is the model used when a
 * request omits one; `allowedModels` is the per-provider model allow-list that
 * extends provider gating down to model granularity. `apiVersion` pins the
 * Anthropic version header for the Claude provider and is ignored by the others.
 */
export interface AIProviderConfig {
  /** Secret API key. Read from the environment (e.g. `ANTHROPIC_API_KEY`). Never logged, never placed in a prompt or error. */
  apiKey: string
  /** BYOK / self-host base URL. Defaults to the provider's public endpoint. Validated against the SSRF guard. */
  baseUrl?: string
  /** Model used when a request does not specify one. Defaults to the provider's built-in recommended model. */
  defaultModel?: string
  /** Per-provider model allow-list. When present, a requested model outside it is rejected. */
  allowedModels?: string[]
  /** Claude only: the `anthropic-version` header value. Ignored by OpenAI-compatible providers. */
  apiVersion?: string
}

/**
 * The vector-store / embedding block. Present when a host opts into
 * embeddings. It configures the single embedding provider (a generic
 * OpenAI-compatible backend by default) plus the storage shape. `dimension` is
 * baked into the `vector(N)` column at migrate time and validated to 1..2000 at
 * boot. `maxEmbeddingTokens` is the per-chunk worst-case reserved against
 * `aiTokens`. `authorizeIngestion` is the write gate (distinct from
 * `authorizeAIAccess`), and the `*Max*` bounds cap one ingest request.
 */
export interface AIEmbeddingConfig extends AIProviderConfig {
  /** The embedding provider name (a registered `AIEmbeddingProviderContract`). Default `'openai-compatible'`. */
  provider?: AIProviderName
  /** The vector dimension baked into the embeddings column. Default 1536; must be 1..2000. */
  dimension?: number
  /** Per-chunk worst-case token estimate reserved against `aiTokens`. Default 512. */
  maxEmbeddingTokens?: number
  /** Max characters per input chunk. A longer chunk is a 400 before any cost. */
  maxChunkChars?: number
  /** Max chunks in one ingest request. */
  maxBatchChunks?: number
  /** Max serialized bytes of a chunk's `metadata` object. */
  maxMetadataBytes?: number
  /**
   * Max bytes of a document fetched by `sourceUrl` (through the SSRF-pinned
   * fetch). The transfer is streamed and aborted the moment the running total
   * crosses this cap, so the body is never fully buffered first. Default 1 MiB.
   */
  ingestionMaxBytes?: number
  /**
   * Request deadline in ms for a `sourceUrl` document fetch. A slow or hung
   * upstream (past the SSRF pin) is aborted at this deadline rather than pinning
   * an ingest worker. Default 10000.
   */
  ingestionTimeoutMs?: number
  /**
   * The write authorization gate: called before an ingest reserves or embeds
   * anything. Return `false` or throw to deny with a 403 (`ingestion_denied`).
   * Distinct from {@link AiConfig.authorizeAIAccess} (which gates "may this
   * caller use AI at all"); this gates "may this caller write to the index".
   */
  authorizeIngestion?: TenantAccessAuthorizer
}

/**
 * How a {@link RetrievalFilter} scopes a tenant's corpus to what THIS user may
 * see. A discriminated union so the intent is explicit and exhaustive:
 * `all` is the whole tenant corpus, `sources` an allow-list over the provenance
 * `source` key (an empty list is a valid "sees nothing"), `metadata` a jsonb
 * containment match. Tenant isolation is always enforced underneath this
 * scope; it only narrows retrieval WITHIN the already tenant-scoped index.
 */
export type RetrievalScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'sources'; readonly sources: readonly string[] }
  | { readonly kind: 'metadata'; readonly match: Record<string, unknown> }

/**
 * The per-user document ACL hook. Called with the request context and the
 * resolved tenant, it returns the {@link RetrievalScope} a retrieval is narrowed
 * to. Distinct from {@link AiConfig.authorizeAIAccess} ("may this caller use AI
 * at all"): this answers "WHICH of the tenant's documents may this caller
 * retrieve". A throw or an invalid return is fail-closed (403
 * `retrieval_denied`). When the hook is ABSENT, retrieval is fail-closed too
 * (every request is refused) UNLESS the host opts into the whole tenant corpus
 * with {@link AiConfig.acknowledgeUnscopedRetrieval} (tenant isolation still
 * holds); the `ai_retrieval_gate` doctor check and a boot warning keep that
 * decision visible.
 */
export type RetrievalFilter = (
  ctx: HttpContext,
  tenant: TenantModelContract
) => RetrievalScope | Promise<RetrievalScope>

/**
 * The retrieval (RAG) block, present when a host opts into similarity
 * search over the vector store. `retrievalFilter` is the per-user document ACL;
 * the bounds cap a retrieval request and the size of a retrieved context
 * block folded into a chat prompt (#8, output bounds). Retrieval reuses the
 * embedding provider from {@link AIEmbeddingConfig} to embed the query, so
 * `config.ai.embedding` must be present for retrieval to work.
 */
export interface AIRetrievalConfig {
  /** The per-user document ACL. Absent means the whole tenant corpus (a documented honest limit). */
  retrievalFilter?: RetrievalFilter
  /** Default number of nearest matches when a request omits one. Default 8. */
  defaultLimit?: number
  /** Hard cap on the number of matches one request may ask for. Default 50. */
  maxLimit?: number
  /** Max characters of the query text. A longer query is a 400 before any cost. Default 4000. */
  maxQueryChars?: number
  /** Max retrieved documents folded into one chat context block (#8). Default 8. */
  maxContextItems?: number
  /** Max characters of the fenced retrieved context block injected into a chat prompt (#8). Default 8000. */
  maxContextChars?: number
}

/**
 * The conversation memory block, present when a host opts into
 * per-(tenant,user,session) chat history. Memory is encrypted at rest (enc_v2,
 * its own secret class), TTL-bounded in Redis, and replayed into the context as
 * `user`/`assistant` turns (never `system`, so a poisoned turn cannot rewrite
 * the instructions: #1/#10). Sessions are server-minted and HMAC-bound to the
 * (tenant, {@link AiConfig.resolvePrincipal | principal}) pair, so a client
 * cannot supply or guess one to reach another principal's memory; the
 * `X-Ai-Session` response header hands the token back on the first turn. Absent
 * block means chat stays stateless and `sessionId` keeps its opaque idempotency-scope
 * meaning. Requires a resolvable principal; without one the `ai_memory` doctor
 * check warns and memory is inert.
 */
export interface AIMemoryConfig {
  /** Prior exchanges (user+assistant pairs) replayed into a chat context; older ones are dropped. Default 20. Must be >= 1. */
  maxTurns?: number
  /** Character budget for the replayed memory block, folded within `maxPromptChars` (#8). Default 8000. */
  maxChars?: number
  /** Sliding TTL for a session's memory in ms, refreshed each turn. Default 86400000 (24h). */
  ttlMs?: number
}

/**
 * The append-only audit block. Audit is ON by default when
 * `config.ai` is present (attribution is a security control, so fail-closed):
 * every chat / embedding / retrieval choke point writes a non-PII, hash-chained
 * row into the append-only `backoffice.ai_audit_logs` table, and a write outage
 * fails the request (503). A completed SSE stream cannot be un-sent, so a chat
 * audit outage instead trips `guard.ai_audit_write_failed` and leaves a seq gap
 * that `tenant:ai:audit:verify` reports. External WORM/SIEM anchoring reuses the
 * kernel `AuditLogDestinationRegistry`, so it is wired the host way, not here.
 */
export interface AIAuditConfig {
  /**
   * Persist AI audit rows. Default true when `config.ai` is present. Setting it
   * false disables the DB-backed audit entirely (the choke-point events fall back
   * to the no-op sinks) and silences the `ai_audit` doctor check.
   */
  enabled?: boolean
}

/**
 * Per-operation failure policy for the request-path Redis reads (Wave 1). Each
 * read routes through the kernel `ResilienceService.run` via an injected closure,
 * so a dependency outage degrades by this POLICY rather than an ad-hoc per-call
 * `try/catch`. Every field is optional and defaults to today's semantics exactly,
 * so an absent `resilience` block changes nothing; a `policy` that is neither
 * `'fail-open'` nor `'fail-closed'` is a boot `fail()`.
 */
export interface AIResilienceConfig {
  /** Conversation-memory read. Default `fail-open` (a lost history degrades gracefully, bounded by the TTL). */
  memory?: { policy?: FailurePolicy }
  /** Idempotency lookup / epoch read. Default `fail-open` (a skipped replay is safe; save stays best-effort regardless). */
  idempotency?: { policy?: FailurePolicy }
  /** Per-key rate-limit consume. Default `fail-closed` (a blind cost limiter must not pass; an outage is a 503 `rate_limit_unavailable`). */
  rateLimit?: { policy?: FailurePolicy }
}

/**
 * A tenant's data-residency posture (#7 / #15), resolved per tenant. Either
 * `local-only` (no remote egress: every provider and embedding backend whose
 * effective endpoint is not loopback is refused) or an explicit per-tenant
 * provider allow-list that narrows the global {@link AiConfig.allowedProviders}.
 * A discriminated union so the intent is explicit and exhaustive.
 */
export type ResidencyPosture =
  | { readonly mode: 'local-only' }
  | { readonly allowedProviders: readonly AIProviderName[] }

/**
 * The per-tenant residency hook (#7 / #15), enforced at request time BEFORE any
 * cost: on chat provider selection AND on embedding egress (embed / retrieve,
 * which have no other provider choke point). It is fail-closed (mirrors
 * {@link RetrievalFilter}): a throw or a malformed return refuses remote egress
 * with a 403 `residency_denied`. Absent means residency is unconstrained (the global
 * allow-list still applies). Provider identity is checked, not endpoint
 * geography: a documented honest limit (a BYOK `baseUrl` is the host's to place).
 */
export type ResidencyResolver = (
  tenant: TenantModelContract
) => ResidencyPosture | Promise<ResidencyPosture>

/**
 * An optional host hook to redact or transform the model's streamed output, as
 * host-owned defense-in-depth (a corporate DLP / PII-redaction policy, say).
 * Called per streamed chat fragment AFTER the mandatory output size bound, with the
 * request context, the resolved tenant, and the fragment's text; return the
 * (possibly redacted) text, or `null` to abort the stream.
 *
 * It is **never the isolation control**: the tenant-pure context and the output
 * bound are the guarantee. A redactor cannot detect a leak that the tenant-pure
 * context already makes impossible, and it does not substitute for tenant
 * isolation. It is sync and
 * per-fragment on purpose (async per-token DLP would kill streaming latency), so
 * a pattern split across two fragments can be missed. A throwing or
 * non-string-returning redactor fails closed (aborts the stream), so unredacted
 * bytes are never emitted. The redacted bytes are what the client receives AND
 * what is cached for idempotent replay and persisted to conversation memory.
 */
export type RedactOutput = (
  ctx: HttpContext,
  tenant: TenantModelContract,
  chunk: string
) => string | null

/**
 * A verdict from a host {@link InjectionClassifier}. `block` refuses the request
 * with a 400 `injection_detected`; `allow` proceeds. `reason` is a short, log-safe
 * string for the operator, NEVER echoed to the client (a refusal must not teach an
 * attacker what tripped it).
 */
export interface InjectionVerdict {
  readonly action: 'allow' | 'block'
  readonly reason?: string
}

/**
 * The INPUT-side prompt-injection detection seam (Wave 3, LLM01), symmetric to
 * {@link RedactOutput} on the output side. A host plugs in its own semantic policy
 * (a corporate classifier, a hosted moderation endpoint, a fine-tuned guard model);
 * the package ships NO bundled regex ruleset as a default, because a pattern wall
 * masquerading as protection is the theater the design rejects.
 *
 * It is **never the isolation control**: the boundary is structural role separation
 * plus invariant I4 (nothing cross-tenant is ever in the context), which holds
 * whether the classifier ran, passed, failed, or was never configured. So it runs on
 * INPUT before any spend and CAN be `async` at zero streaming-latency cost (the
 * deliberate contrast with the sync, per-fragment `RedactOutput`), and its own error
 * is fail-OPEN by default: an input detector's outage cannot cause a leak, so denying
 * every request when a moderation endpoint has a bad minute is availability damage for
 * no security gain. A host whose threat model prefers the stricter coupling sets
 * {@link AIInjectionConfig.onError} to `'closed'`.
 */
export type InjectionClassifier = (
  ctx: HttpContext,
  tenant: TenantModelContract,
  input: { readonly text: string; readonly origin: 'user' | 'retrieved' | 'tool' }
) => InjectionVerdict | Promise<InjectionVerdict>

/**
 * The optional injection block (Wave 3). Absent means the structural boundary is the
 * only defense (the correct, no-theater default); the `ai_injection` doctor check
 * reports whichever posture is live.
 */
export interface AIInjectionConfig {
  /** The host semantic classifier. Absent ⇒ no semantic detection (structural boundary only). */
  classifier?: InjectionClassifier
  /**
   * Fail posture when the classifier itself throws or returns a malformed verdict.
   * Default `'open'` (the classifier is NOT the boundary, so its outage must not deny
   * traffic). `'closed'` couples availability to the detector, knowingly.
   */
  onError?: 'open' | 'closed'
  /**
   * Also run the classifier over the assembled retrieved-context block (`origin:
   * 'retrieved'`). Default false: the structural fence + `user`-role separation
   * already contain retrieved content as data, so this is opt-in extra latency.
   */
  scanRetrieved?: boolean
}

/**
 * How {@link AIToolsConfig.authorizeTool} scopes a single tool call (WS-AI-11). A
 * discriminated union so the intent is explicit and exhaustive: `deny` refuses the
 * call, `allow` runs it, and an `allow` may carry a `filter` that narrows WHAT the
 * tool may see (handed to the handler as {@link ToolContext.filter}, e.g. a
 * per-user row scope). Fail-closed everywhere it is consumed: an absent hook or an
 * invalid return is a deny unless the host opts into
 * {@link AIToolsConfig.acknowledgeUnauthorizedTools}. Mirrors {@link RetrievalScope}.
 */
export type ToolScope =
  | { readonly kind: 'allow'; readonly filter?: Record<string, unknown> }
  | { readonly kind: 'deny' }

/**
 * The context a tool handler runs in. `tenant` and `ctx` are the request's
 * resolved tenant and HTTP context; the handler runs INSIDE `tenancy.run(tenant)`
 * (so a `TenantBaseModel` query hits the right schema) with the active scope
 * re-asserted first (the I7 defense: a tool cannot query another tenant). `signal`
 * aborts on client disconnect, the request deadline, OR the per-tool timeout.
 * `filter` is the optional narrowing returned by `authorizeTool`.
 */
export interface ToolContext {
  readonly tenant: TenantModelContract
  readonly ctx: HttpContext
  readonly signal: AbortSignal
  readonly filter?: Record<string, unknown>
  /**
   * Present only for a confirmed action tool (WS-AI-11 Phase 3a): a stable key for
   * THIS effect, derived from the confirmation that authorized it. The satellite
   * already fences the effect at most once, so a handler needs this only when its
   * own downstream (a payment provider, an external API) wants an idempotency key
   * of its own. Never present for a read tool.
   */
  readonly idempotencyKey?: string
}

/**
 * A tool the host makes available to the model. Extends the wire-facing
 * {@link AIToolDefinition} (name / description / inputSchema / mode) with the
 * server-side executable surface: the `handler`, an optional per-tool
 * `requiresConfirmation` (action tools, Phase 3a), and an optional host
 * `parseInput` validator (e.g. a vine schema, the app's OWN dependency, never the
 * satellite's) that supersedes the shipped JSON-Schema-subset checker. `mode:
 * 'action'` marks a mutating tool, a hard-gated capability refused until it is
 * explicitly enabled and confirmed (Phase 3a); read tools are the zero-config default.
 */
export interface AIToolHostDefinition extends AIToolDefinition {
  readonly handler: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
  /**
   * Skip the human confirmation for this action tool. Defaults to `true` for
   * `mode: 'action'` (confirmation required) and is meaningless for a read tool.
   *
   * Setting it `false` is the sharpest edge in the package and it is deliberately
   * awkward to reach: the tool still needs the kill-switch on, an explicit
   * `authorizeTool` allow, a resolvable principal and the at-most-once fence. It
   * skips only the human. Reserve it for a low-risk, reversible, narrowly-scoped
   * mutation, and know that an indirect prompt injection can then perform it.
   */
  readonly requiresConfirmation?: boolean
  /**
   * Render the one line a human reads before confirming this action. MANDATORY for
   * `mode: 'action'`: a tool without it is refused, per tool, rather than shipped
   * with a weaker default.
   *
   * The reason is security, not ergonomics. The human's decision is only as good as
   * what they are shown, so if the model wrote that text an injection could author
   * its own confirmation prompt and the whole flow becomes a rubber stamp. This
   * runs on the host's side of the boundary, over the VALIDATED arguments, so no
   * model prose can reach it. Return something a person can actually judge
   * ("Cancel booking BK-1042 for Ana Ruiz, refunding 450 MAD"), and remember it is
   * shown to that user: it may name their own data but must not carry anything they
   * should not see. Bounded to {@link AI_TOOL_ARGS_SUMMARY_MAX_CHARS}.
   */
  readonly summarizeArgs?: (args: Record<string, unknown>) => string
  readonly parseInput?: (raw: unknown) => unknown
}

/** Resolve the tools available to THIS request (per-tenant default-deny). Absent ⇒ the static registry, or none. */
export type AIToolResolver = (
  ctx: HttpContext,
  tenant: TenantModelContract
) => AIToolHostDefinition[] | Promise<AIToolHostDefinition[]>

/** The per-tool authorization hook, mirroring {@link RetrievalFilter}. Fail-closed (throw / invalid ⇒ deny). */
export type AIToolAuthorizer = (
  ctx: HttpContext,
  tenant: TenantModelContract,
  toolName: string
) => ToolScope | Promise<ToolScope>

/**
 * The tool / function-calling block (WS-AI-11), present when a host opts into
 * tool calling. Default-deny throughout: with no `registry`/`resolveTools` the
 * model is offered no tools; with tools present but no `authorizeTool` and no
 * `acknowledgeUnauthorizedTools`, every tool call is refused. Action (mutating)
 * tools are OFF behind `actionTools.enabled`, and even switched on they need a
 * per-tool `authorizeTool` allow, a host-authored `summarizeArgs`, a resolvable
 * principal and a human confirmation. Every `max*`/`*Ms` bound is a named-constant
 * default, clamped to a hard ceiling.
 */
export interface AIToolsConfig {
  /** A static tool registry. Combined with `resolveTools` when both are present. */
  registry?: AIToolHostDefinition[]
  /** Per-request, per-tenant tool resolution (default-deny). Absent ⇒ the static registry, or none. */
  resolveTools?: AIToolResolver
  /** The per-tool authorization hook. Absent ⇒ deny unless `acknowledgeUnauthorizedTools`. */
  authorizeTool?: AIToolAuthorizer
  /** Opt into running READ tools with NO `authorizeTool` wired (tenant isolation still holds). Ignored by action tools. */
  acknowledgeUnauthorizedTools?: boolean
  /**
   * The action-tool kill-switch. Default OFF: every `mode: 'action'` tool is
   * unadvertised and refused, however it is registered. One flag turns all writes
   * off.
   *
   * HONEST LIMIT: this is static app config read at boot, so flipping it needs a
   * restart. There is no hot global off. A host that wants a runtime, per-tenant
   * lever (a feature flag killing mutations for one company) wires it in its own
   * `resolveTools` or `authorizeTool`, which are consulted per request.
   */
  actionTools?: { enabled?: boolean }
  /** Max provider rounds. Default 4, clamped to 8. */
  maxRounds?: number
  /** Max tool calls executed per round. Default 4, clamped to 8. */
  maxToolsPerRound?: number
  /** Max total tool calls across one request. Default and hard cap 16. */
  maxToolCallsPerRequest?: number
  /** Per-tool execution deadline in ms. Default 5000, clamped to 30000. */
  toolTimeoutMs?: number
  /** Max characters of a fenced tool result. Default 4000, clamped to 16000. */
  maxToolResultChars?: number
  /** Max characters of a tool call's raw arguments (bounded before JSON.parse). Default 8000, clamped to 16000. */
  maxToolArgsChars?: number
  /** Max concurrent in-flight streams admitting a tool loop, per tenant. Default 8, clamped to 32. */
  maxConcurrentPerTenant?: number
  /** Surface tool-call arguments in the client `tool_call` notice. Default false (name + id only). */
  surfaceToolArgs?: boolean
}

/**
 * AI satellite config. Opt-in via `--with=ai` and declaring `config.ai`.
 * Provider-agnostic: allow-list the providers a tenant may use, fill in the
 * matching per-provider block, and pick a default. Every value is optional with
 * a named-constant default except the allow-list and the blocks a provider
 * needs, so nothing streaming-related is hardcoded.
 */
export interface AiConfig {
  /**
   * The default provider when a tenant does not override it. Defaults to
   * `'claude'`. The effective default must appear in `allowedProviders`.
   */
  defaultProvider?: AIProviderName
  /**
   * The per-tenant default-deny allow-list. A provider is selectable only
   * if it is listed here; a newly registered provider is never auto-enabled.
   * Required and non-empty when `config.ai` is present.
   */
  allowedProviders: AIProviderName[]
  /** Claude (Anthropic Messages) provider config. Required when `claude` is allow-listed. */
  claude?: AIProviderConfig
  /** DeepSeek (OpenAI-compatible) provider config. Required when `deepseek` is allow-listed. */
  deepseek?: AIProviderConfig
  /** Kimi / Moonshot (OpenAI-compatible) provider config. Required when `kimi` is allow-listed. */
  kimi?: AIProviderConfig
  /** The vector store / embedding block. Present when the host opts into embeddings. */
  embedding?: AIEmbeddingConfig
  /** The retrieval / RAG block. Present when the host opts into similarity search over the vector store. */
  retrieval?: AIRetrievalConfig
  /** The conversation memory block. Present when the host opts into per-(tenant,user,session) chat history. */
  memory?: AIMemoryConfig
  /** SSE heartbeat interval in ms. Default 15000. Must stay below any upstream proxy idle timeout. */
  heartbeatMs?: number
  /** Response deadline in ms for a streamed call. The composed abort fires at the deadline. */
  timeoutMs?: number
  /** Default per-request output token cap when a request omits `maxTokens`. Becomes the reservation worst case. */
  maxTokens?: number
  /**
   * The AI membership gate, mirroring core's `authorizeTenantAccess`
   * contract: called by the gateway after tenant resolution and the host's
   * auth middleware, with the request context and the resolved tenant.
   * Return `false` or throw to deny with a 403. Unlike the core hook, which
   * only warns when unset, `multitenancyAiRoutes` REFUSES TO MOUNT without
   * this hook unless {@link acknowledgeNoMembershipGate} is explicitly true:
   * AI routes are tenant-scoped and cost-bearing, so default-deny.
   */
  authorizeAIAccess?: TenantAccessAuthorizer
  /**
   * Explicit acknowledgement that the host mounts AI routes WITHOUT a
   * membership gate (its own middleware chain is the only access control).
   * Mounting logs a warning and the `ai_membership_gate` doctor check keeps
   * reporting the posture, so the opt-out stays visible to operators.
   */
  acknowledgeNoMembershipGate?: boolean
  /**
   * Resolve the authenticated principal an idempotent replay may be shared
   * with. Defaults to the host's `@adonisjs/auth` user id when present. A
   * request with no resolvable principal gets NO idempotency (a cached
   * response must never be shareable across unknown callers).
   *
   * MUST return a STABLE, immutable per-user id (a primary key, not a mutable
   * email): idempotency, audit attribution AND conversation memory all bind to
   * it. A change correctly orphans that principal's memory, bounded by the memory
   * TTL, so a mutable value silently loses history.
   */
  resolvePrincipal?: (ctx: HttpContext) => string | number | null | undefined
  /**
   * How long a completed response stays replayable under its
   * `Idempotency-Key`, in ms. Default 60000. Short on purpose: the cache
   * exists to absorb client retries, not to be a response store.
   */
  idempotencyTtlMs?: number
  /**
   * Upper bound on the combined `messages[].content` length of one request,
   * in characters. Default 32000. A request over the bound is rejected with
   * a 400 before any reservation or provider call.
   */
  maxPromptChars?: number
  /**
   * Per-tenant, per-provider-key request rate limit (threat #4, denial of
   * wallet). When set, each streamed request consumes one hit against
   * `ext:ai:<op>:<tenant>:<keyFingerprint>`; over `limit` in `windowSeconds` is
   * a 429, and a limiter-backend outage is a fail-closed 503. Absent leaves the
   * `aiTokens` cost reserve as the only cap. This is a DIFFERENT rail from the
   * per-plan `aiTokens` budget in `config.plans`: a request rate, not a token
   * spend. A replay served from cache does not consume it.
   */
  rateLimit?: { limit: number; windowSeconds: number }
  /**
   * Explicit acknowledgement that the AI endpoint runs WITHOUT an `aiTokens`
   * budget (no per-plan `limits.aiTokens` and no `plans.operatorCeiling.aiTokens`),
   * so the kernel's cost reserve is inert and the endpoint is unmetered. Silences
   * the boot warning; the `ai_budget` doctor check still reports the accepted
   * risk. A dynamic per-tenant budget (via `plans.getPlan` / `tenant_plans`) is
   * invisible to the static boot check and does not need this.
   */
  acknowledgeUnbudgetedAiTokens?: boolean
  /**
   * Opt into tenant-wide retrieval when no `config.ai.retrieval.retrievalFilter`
   * (per-user document ACL) is wired. Retrieval is fail-closed (mirrors the
   * membership mount gate): without a hook AND without this flag, every `/ai/retrieve` and
   * RAG chat is refused with a 403 `retrieval_denied`. Setting this to `true`
   * ENABLES retrieval and accepts that every user of a tenant can retrieve that
   * tenant's ENTIRE corpus; the `ai_retrieval_gate` doctor check then reports the
   * accepted posture (info) instead of the refused one (warn). Tenant isolation
   * is unaffected: this is about intra-tenant, per-user document
   * authorization, which is the host's job.
   */
  acknowledgeUnscopedRetrieval?: boolean
  /** The append-only audit block. On by default; set `enabled: false` to opt out. */
  audit?: AIAuditConfig
  /**
   * Per-operation failure policy for the request-path Redis reads. Absent ⇒ today's
   * semantics exactly (memory / idempotency fail-open, rate-limit fail-closed). See
   * {@link AIResilienceConfig}.
   */
  resilience?: AIResilienceConfig
  /**
   * The tool / function-calling block (WS-AI-11). Present when the host opts into
   * letting the model call server-defined tools. Default-deny; see {@link AIToolsConfig}.
   */
  tools?: AIToolsConfig
  /**
   * Per-tenant data residency / no-train posture (#7 / #15). When set, a request
   * whose selected provider (chat) or embedding backend (embed / retrieve) is
   * outside the tenant's posture is refused with a 403 `residency_denied` before
   * any reservation. See {@link ResidencyResolver}.
   */
  residency?: ResidencyResolver
  /**
   * Optional host output-redaction hook (defense-in-depth, NEVER the isolation
   * control). Redacts or aborts each streamed chat fragment after the mandatory
   * output bound; the redacted bytes are what the client receives AND what is
   * cached for idempotent replay and persisted to conversation memory. See
   * {@link RedactOutput}.
   */
  redactOutput?: RedactOutput
  /**
   * Optional INPUT-side prompt-injection detection (Wave 3, LLM01), defense-in-depth
   * and NEVER the isolation control (structural role separation plus I4 is). A host
   * classifier's `block` verdict refuses the request with a 400 `injection_detected`
   * before any spend; its own error is fail-open by default. See {@link AIInjectionConfig}.
   */
  injection?: AIInjectionConfig
  /**
   * Per-BATCH `statement_timeout` (ms) for the batched compliance purge. Bounds a
   * single lock-blocked or runaway delete batch so it fails cleanly and the loop
   * retries; it is NOT a wall clock on the whole erasure (an erasure must run to
   * completion). Default: the connection default (no per-batch timeout). Must be
   * a positive integer <= 600000.
   */
  purgeStatementTimeoutMs?: number
}

/**
 * Augment core's open `SatelliteConfigRegistry` so `getConfig().ai` (and any
 * `MultitenancyConfig` consumer) is typed wherever the AI satellite is imported.
 * The augmentation lives in this package's compilation only, so core, which
 * never imports the AI satellite, keeps an `ai`-free public type. Mirrors the
 * billing / reporting satellites.
 */
declare module '@adonisjs-lasagna/saas-tenancy/types' {
  interface SatelliteConfigRegistry {
    /** Optional AI satellite. See {@link AiConfig}. */
    ai?: AiConfig
  }
}

/**
 * The host's `config/multitenancy.ts` shape with the `ai` block present. Mirrors
 * `MultitenancyConfigWithBilling` so every config-bearing satellite exposes the
 * same authoring surface.
 */
export type MultitenancyConfigWithAi = MultitenancyConfig & { ai?: AiConfig }

/**
 * Identity helper for IDE autocomplete + type-checking when authoring the `ai`
 * block of `config/multitenancy.ts`. No runtime effect.
 */
export function defineAiConfig(config: AiConfig): AiConfig {
  return config
}
