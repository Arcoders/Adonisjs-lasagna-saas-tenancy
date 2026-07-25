import type { AIProviderName } from '../define_config.js'

/**
 * A request to embed one or more text chunks. `input` is the ordered list of
 * texts to turn into vectors; `model` is a per-request override validated
 * against the provider's `allowedModels`. Both are input, never class
 * constants. Readonly: a caller hands the provider an immutable request.
 */
export interface AIEmbeddingRequest {
  readonly input: readonly string[]
  readonly model?: string | undefined
}

/**
 * The result of an embedding call. `embeddings[i]` is the vector for
 * `input[i]`, in the same order and count. `dimension` is the length every
 * vector MUST have: it is the binding surface the vector store stamps on each
 * row and filters reads on, so a silent model swap that changes dimension is
 * caught rather than mis-ranked. `tokens` is the provider-reported usage,
 * settled against the `aiTokens` reservation (a non-streaming call still costs
 * money, so it is metered like a chat completion).
 */
export interface AIEmbeddingResult {
  readonly embeddings: readonly (readonly number[])[]
  readonly model: string
  readonly dimension: number
  readonly tokens: number
}

/** What an embedding provider declares it can do. A future embedding registry
 * gates on `embedding`, mirroring how the chat registry gates on `streaming`. */
export interface AIEmbeddingCapabilities {
  readonly embedding: boolean
}

/**
 * The contract every embedding provider satisfies. It mirrors
 * {@link AIProviderContract} but is non-streaming: one call turns text into
 * vectors. It is the public extension seam for the vector store: a
 * host implements it to add an embedding backend, and the ingestion path
 * streams the request over the kernel's IP-pinned fetch so every AI-initiated
 * URL stays SSRF-checked.
 */
export interface AIEmbeddingProviderContract {
  /** The provider's stable name (matches an `allowedModels` block / a config slice). */
  readonly name: AIProviderName

  /**
   * The contract version this provider was built against (see
   * `AI_CONTRACT_VERSION`). Absent registers with a one-time "unversioned"
   * warning, never a failure; declare it to opt into the compatibility check.
   */
  readonly contractVersion?: number | undefined

  /** What the provider can do. `embedding` MUST be `true`. */
  readonly capabilities: AIEmbeddingCapabilities

  /**
   * A stable, one-way fingerprint of the provider's active API key (never the
   * key itself), for the per-key request rate limit
   * (`ext:ai:<op>:<tenant>:<keyFingerprint>`) and audit attribution. Optional:
   * a provider that cannot expose one is keyed by its `name` instead.
   */
  readonly keyFingerprint?: string | undefined

  /**
   * Boot-time validation of the provider's config slice (key presence, and for
   * a BYOK `baseUrl` the endpoint against the SSRF guard). Runs from
   * `AiProvider.boot()` so a missing key fails at boot, not at the first embed.
   */
  verifyConfig(): Promise<void>

  /**
   * Embed `request.input` into vectors. The returned `embeddings` are in the
   * same order and count as the input, each of length `dimension`. The `signal`
   * is the composed abort (tenant liveness / timeout); the provider MUST stop
   * and release its transport when it fires.
   */
  embed(request: AIEmbeddingRequest, signal: AbortSignal): Promise<AIEmbeddingResult>
}
