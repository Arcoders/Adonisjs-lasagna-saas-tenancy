import OpenAICompatibleEmbeddingProvider from '../providers/openai_compatible_embedding_provider.js'
import type { AIEmbeddingProviderContract } from '../types/ai_embedding_contract.js'
import type { AIEmbeddingConfig } from '../define_config.js'

/**
 * Holds an optional host override for the single embedding provider, mirroring
 * {@link AIProviderRegistry} on the chat side. By default {@link resolve} builds the
 * configured OpenAI-compatible `/embeddings` backend, byte-identical to the previous
 * inline construction, so with no host override the ingestion/retrieval path is
 * unchanged. A host registers its own provider (for local dev without an embeddings
 * API, or an offline `MockEmbeddingProvider` in an e2e suite) and it supersedes the
 * default. Because `EmbeddingIngestionService`/`RetrievalService` resolve this
 * registry at make-time (route registration, after every provider `boot()`), an
 * override registered in a host provider's `boot()` is always present in time.
 *
 * Stateful (it holds the override), so it must be resolved via `container.make(...)`,
 * never `new`-ed ad hoc, like the other AI registries.
 */
export default class EmbeddingProviderRegistry {
  #override: AIEmbeddingProviderContract | undefined

  /** Register a host embedding provider; it supersedes the configured default. */
  register(provider: AIEmbeddingProviderContract): this {
    this.#override = provider
    return this
  }

  /** Whether a host override is registered (the default builder is bypassed). */
  has(): boolean {
    return this.#override !== undefined
  }

  /** Drop any override, restoring the configured default. */
  clear(): this {
    this.#override = undefined
    return this
  }

  /**
   * The embedding provider to use: the host override if one is registered, else the
   * configured OpenAI-compatible backend (`baseUrl` validated at boot; a host points
   * it at OpenAI, Voyage, Jina, or a self-hosted endpoint, nothing is vendor-hardcoded).
   */
  resolve(embedding: AIEmbeddingConfig): AIEmbeddingProviderContract {
    return (
      this.#override ??
      new OpenAICompatibleEmbeddingProvider(
        {
          name: embedding.provider ?? 'openai-compatible',
          baseUrl: embedding.baseUrl ?? '',
          defaultModel: embedding.defaultModel,
        },
        embedding
      )
    )
  }
}
