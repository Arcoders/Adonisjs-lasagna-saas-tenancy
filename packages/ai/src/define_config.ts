import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'

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
  /** Model used when a request does not specify one. */
  defaultModel: string
  /** Per-provider model allow-list. When present, a requested model outside it is rejected (G12 model scope). */
  allowedModels?: string[]
  /** Claude only: the `anthropic-version` header value. Ignored by OpenAI-compatible providers. */
  apiVersion?: string
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
  /** SSE heartbeat interval in ms. Default 15000. Must stay below any upstream proxy idle timeout. */
  heartbeatMs?: number
  /** Response deadline in ms for a streamed call. The composed abort fires at the deadline. */
  timeoutMs?: number
  /** Default per-request output token cap when a request omits `maxTokens`. Becomes the reservation worst case. */
  maxTokens?: number
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
