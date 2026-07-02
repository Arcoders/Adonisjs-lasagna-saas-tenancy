import type { HttpContext } from '@adonisjs/core/http'
import type {
  MultitenancyConfig,
  TenantAccessAuthorizer,
} from '@adonisjs-lasagna/saas-tenancy/types'

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
 * scopes G12 to model granularity. `apiVersion` pins the Anthropic version
 * header for the Claude provider and is ignored by the others.
 */
export interface AIProviderConfig {
  /** Secret API key. Read from the environment (e.g. `ANTHROPIC_API_KEY`). Never logged, never placed in a prompt or error. */
  apiKey: string
  /** BYOK / self-host base URL. Defaults to the provider's public endpoint. Validated against the SSRF guard. */
  baseUrl?: string
  /** Model used when a request does not specify one. Defaults to the provider's built-in recommended model. */
  defaultModel?: string
  /** Per-provider model allow-list. When present, a requested model outside it is rejected (G12 model scope). */
  allowedModels?: string[]
  /** Claude only: the `anthropic-version` header value. Ignored by OpenAI-compatible providers. */
  apiVersion?: string
}

/**
 * The vector-store / embedding block (WS-AI-3). Present when a host opts into
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
  /** Max bytes of a document fetched by `sourceUrl` (through the SSRF-pinned fetch). */
  ingestionMaxBytes?: number
  /**
   * The write authorization gate: called before an ingest reserves or embeds
   * anything. Return `false` or throw to deny with a 403 (`ingestion_denied`).
   * Distinct from {@link AiConfig.authorizeAIAccess} (which gates "may this
   * caller use AI at all"); this gates "may this caller write to the index".
   */
  authorizeIngestion?: TenantAccessAuthorizer
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
   * The per-tenant default-deny allow-list (G12). A provider is selectable only
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
  /** The vector store / embedding block (WS-AI-3). Present when the host opts into embeddings. */
  embedding?: AIEmbeddingConfig
  /** SSE heartbeat interval in ms. Default 15000. Must stay below any upstream proxy idle timeout. */
  heartbeatMs?: number
  /** Response deadline in ms for a streamed call. The composed abort fires at the deadline. */
  timeoutMs?: number
  /** Default per-request output token cap when a request omits `maxTokens`. Becomes the reservation worst case. */
  maxTokens?: number
  /**
   * The AI membership gate (G4), mirroring core's `authorizeTenantAccess`
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
