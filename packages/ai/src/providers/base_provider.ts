import { createHash } from 'node:crypto'
import {
  safeFetch,
  SafeFetchError,
  type SafeFetchOptions,
} from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import { AI_CONTRACT_VERSION } from '../sdk/contract_version.js'
import AIException from '../exceptions/ai_exception.js'
import { assertModelAllowed } from './model_allowlist.js'
import type { AIProviderConfig, AIProviderName } from '../define_config.js'
import type {
  AICapabilities,
  AIProviderContract,
  AIStreamRequest,
  StreamFragment,
} from '../types/ai_provider_contract.js'

/**
 * The injectable transport seam. `fetch` defaults to the kernel's SSRF-pinned
 * `safeFetch`; tests inject a fake fetch that returns a canned streaming Response
 * so the full adapter (request build to parse to error map) runs in CI without a
 * live key or the network. Mirrors SsoService's injectable-deps pattern.
 */
export interface AIProviderDeps {
  fetch: (url: string, opts: SafeFetchOptions) => Promise<Response>
}

export const defaultAiProviderDeps: AIProviderDeps = { fetch: safeFetch }

/** Read a web ReadableStream body as an async iterable of byte chunks. */
export async function* streamBytes(
  body: ReadableStream<Uint8Array> | null
): AsyncIterable<Uint8Array> {
  if (!body) return
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Shared HTTP+SSE provider base. It never passes `trustedHost`/`allowLoopback`
 * to the transport (they would bypass the SSRF pin), so a self-hosted `baseUrl`
 * is still IP-pinned; a private/metadata endpoint is rejected by the pin at call
 * time and surfaced as `byok_endpoint_blocked`. A non-2xx head becomes a
 * pre-first-byte `AIException` (429 -> rate_limited, else provider_unavailable)
 * so the gateway resolves a `failed_preflight` with the right status. The API key
 * is read from config, never logged and never placed in a prompt or an error.
 */
export abstract class HttpAiProvider implements AIProviderContract {
  abstract readonly name: AIProviderName
  readonly contractVersion = AI_CONTRACT_VERSION
  readonly capabilities: AICapabilities = { streaming: true }

  #keyFingerprint?: string

  /**
   * A one-way SHA-256 fingerprint of the configured API key, never the key
   * itself (mirrors `hashAuditPrincipal`). Feeds the per-key rate-limit bucket
   * (threat #4) and audit attribution. Memoized; safe to log.
   */
  get keyFingerprint(): string {
    if (this.#keyFingerprint === undefined) {
      this.#keyFingerprint = createHash('sha256').update(this.cfg.apiKey).digest('hex')
    }
    return this.#keyFingerprint
  }

  protected constructor(
    protected readonly cfg: AIProviderConfig,
    protected readonly deps: AIProviderDeps = defaultAiProviderDeps,
    /** The provider's built-in recommended model, used when neither the request nor config sets one. */
    protected readonly builtinDefaultModel: string = ''
  ) {}

  async verifyConfig(): Promise<void> {
    if (typeof this.cfg.apiKey !== 'string' || this.cfg.apiKey.length === 0) {
      throw new AIException('config_missing', `${this.name} api key is not configured`)
    }
  }

  async *stream(request: AIStreamRequest, signal: AbortSignal): AsyncIterable<StreamFragment> {
    const model = this.resolveModel(request)
    const res = await this.post(request, model, signal)
    if (res.status < 200 || res.status >= 300) {
      throw new AIException(
        res.status === 429 ? 'rate_limited' : 'provider_unavailable',
        `${this.name} returned HTTP ${res.status}`
      )
    }
    yield* this.parseBody(streamBytes(res.body))
  }

  /** The request model, defaulted from config then the built-in, checked against the allow-list (G12). */
  protected resolveModel(request: AIStreamRequest): string {
    const model = request.model ?? this.cfg.defaultModel ?? this.builtinDefaultModel
    assertModelAllowed(this.name, model, this.cfg.allowedModels, 'stream')
    return model
  }

  private async post(
    request: AIStreamRequest,
    model: string,
    signal: AbortSignal
  ): Promise<Response> {
    try {
      return await this.deps.fetch(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.requestBody(request, model)),
        streaming: true,
        signal,
      })
    } catch (error) {
      // The pin rejected the (BYOK) endpoint at call time: a non-retryable block,
      // not a transient provider outage.
      if (error instanceof SafeFetchError) {
        throw new AIException('byok_endpoint_blocked', `${this.name} endpoint blocked`, {
          cause: error,
        })
      }
      throw error
    }
  }

  protected abstract endpoint(): string
  protected abstract headers(): Record<string, string>
  protected abstract requestBody(request: AIStreamRequest, model: string): unknown
  protected abstract parseBody(source: AsyncIterable<Uint8Array>): AsyncIterable<StreamFragment>
}
