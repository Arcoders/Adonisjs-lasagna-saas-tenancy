import { createHash } from 'node:crypto'
import { SafeFetchError } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import { AI_CONTRACT_VERSION } from '../sdk/contract_version.js'
import AIException from '../exceptions/ai_exception.js'
import { assertModelAllowed } from './model_allowlist.js'
import { defaultAiProviderDeps, type AIProviderDeps } from './base_provider.js'
import { parseOpenAiEmbeddings } from './wire/openai_embeddings.js'
import { OPENAI_EMBEDDINGS_PATH } from './provider_constants.js'
import type { AIProviderConfig, AIProviderName } from '../define_config.js'
import type {
  AIEmbeddingCapabilities,
  AIEmbeddingProviderContract,
  AIEmbeddingRequest,
  AIEmbeddingResult,
} from '../types/ai_embedding_contract.js'

/** The built-in identity of an OpenAI-compatible embedding provider. */
export interface OpenAiEmbeddingParams {
  name: AIProviderName
  /** The default public endpoint; overridden by `config.baseUrl` (BYOK / self-host). */
  baseUrl: string
  /** The default model when neither the request nor config sets one. */
  defaultModel?: string
}

/**
 * A provider for any OpenAI-compatible `/embeddings` endpoint (OpenAI, Voyage,
 * Jina, Cohere-compatible, and self-hosted). One adapter serves them all because
 * they share the wire format; only the name, base URL and model differ. It is
 * non-streaming (embeddings return in one JSON body) and posts through the
 * kernel's pinned `safeFetch`, so a self-hosted `baseUrl` is still IP-pinned:
 * a private/metadata endpoint is rejected by the pin and surfaced as
 * `byok_endpoint_blocked`. No vendor SDK, nothing hardcoded, the key is read
 * from config and never logged or placed in an error.
 */
export default class OpenAICompatibleEmbeddingProvider implements AIEmbeddingProviderContract {
  readonly name: AIProviderName
  readonly contractVersion = AI_CONTRACT_VERSION
  readonly capabilities: AIEmbeddingCapabilities = { embedding: true }

  readonly #baseUrl: string
  readonly #defaultModel?: string
  #keyFingerprint?: string

  constructor(
    params: OpenAiEmbeddingParams,
    protected readonly cfg: AIProviderConfig,
    protected readonly deps: AIProviderDeps = defaultAiProviderDeps
  ) {
    this.name = params.name
    this.#baseUrl = cfg.baseUrl ?? params.baseUrl
    this.#defaultModel = cfg.defaultModel ?? params.defaultModel
  }

  /** A one-way SHA-256 fingerprint of the configured key, never the key itself. */
  get keyFingerprint(): string {
    if (this.#keyFingerprint === undefined) {
      this.#keyFingerprint = createHash('sha256').update(this.cfg.apiKey).digest('hex')
    }
    return this.#keyFingerprint
  }

  async verifyConfig(): Promise<void> {
    if (typeof this.cfg.apiKey !== 'string' || this.cfg.apiKey.length === 0) {
      throw new AIException('config_missing', `${this.name} embedding api key is not configured`)
    }
  }

  async embed(request: AIEmbeddingRequest, signal: AbortSignal): Promise<AIEmbeddingResult> {
    const model = this.#resolveModel(request)
    const res = await this.#post(model, request.input, signal)
    if (res.status < 200 || res.status >= 300) {
      throw new AIException(
        res.status === 429 ? 'rate_limited' : 'provider_unavailable',
        `${this.name} embeddings returned HTTP ${res.status}`
      )
    }
    return parseOpenAiEmbeddings(await res.json(), model)
  }

  /** The request model, defaulted from config then the built-in, checked against the allow-list (G12). */
  #resolveModel(request: AIEmbeddingRequest): string {
    const model = request.model ?? this.#defaultModel
    if (typeof model !== 'string' || model.length === 0) {
      throw new AIException('invalid_request', `${this.name} embeddings require a model`)
    }
    assertModelAllowed(this.name, model, this.cfg.allowedModels, 'embed')
    return model
  }

  async #post(model: string, input: readonly string[], signal: AbortSignal): Promise<Response> {
    try {
      return await this.deps.fetch(`${this.#baseUrl}${OPENAI_EMBEDDINGS_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.cfg.apiKey}`,
        },
        // encoding_format:'float' forces number-array vectors, never base64.
        body: JSON.stringify({ model, input, encoding_format: 'float' }),
        signal,
      })
    } catch (error) {
      if (error instanceof SafeFetchError) {
        throw new AIException('byok_endpoint_blocked', `${this.name} embedding endpoint blocked`, {
          cause: error,
        })
      }
      throw error
    }
  }
}
