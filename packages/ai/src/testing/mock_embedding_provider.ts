import type { AIProviderName } from '../define_config.js'
import type {
  AIEmbeddingCapabilities,
  AIEmbeddingProviderContract,
  AIEmbeddingRequest,
  AIEmbeddingResult,
} from '../types/ai_embedding_contract.js'

/** Construction options for {@link MockEmbeddingProvider}. */
export interface MockEmbeddingProviderOptions {
  /** Provider name. Default `'mock-embedding'`. */
  name?: AIProviderName
  /** The dimension of every produced vector. Default 8 (small + deterministic). */
  dimension?: number
  /** The model name reported back in the result. Default `'mock-embedding-v1'`. */
  model?: string
  /** The declared contract version. Default undefined (registers with a warning). */
  contractVersion?: number
  /** Whether it declares the embedding capability. Default `true`. Set `false` to test a presence gate. */
  embedding?: boolean
  /** When set, `verifyConfig()` rejects with this error. */
  verifyConfigError?: Error
  /** A canned key fingerprint for the per-key rate limit. Default undefined (keyed by name). */
  keyFingerprint?: string
}

/**
 * An in-process `AIEmbeddingProviderContract` for tests: it turns each input
 * text into a deterministic, distinct unit-less vector (a stable hash seeds a
 * small PRNG), records every call for assertions, and honours the abort signal.
 * Deterministic so an isolation spec can assert that two tenants embedding the
 * same text still land in disjoint rows (isolation is structural, not because
 * the vectors differ). Exported from `@adonisjs-lasagna/ai/testing`.
 */
export default class MockEmbeddingProvider implements AIEmbeddingProviderContract {
  readonly name: AIProviderName
  readonly contractVersion?: number
  readonly capabilities: AIEmbeddingCapabilities
  readonly keyFingerprint?: string

  /** Every `embed()` call, in order, for assertions. */
  readonly calls: { request: AIEmbeddingRequest }[] = []

  readonly #dimension: number
  readonly #model: string
  readonly #verifyConfigError?: Error

  constructor(opts: MockEmbeddingProviderOptions = {}) {
    this.name = opts.name ?? 'mock-embedding'
    this.contractVersion = opts.contractVersion
    this.capabilities = { embedding: opts.embedding ?? true }
    this.keyFingerprint = opts.keyFingerprint
    this.#dimension = opts.dimension ?? 8
    this.#model = opts.model ?? 'mock-embedding-v1'
    this.#verifyConfigError = opts.verifyConfigError
  }

  async verifyConfig(): Promise<void> {
    if (this.#verifyConfigError) throw this.#verifyConfigError
  }

  async embed(request: AIEmbeddingRequest, signal: AbortSignal): Promise<AIEmbeddingResult> {
    this.calls.push({ request })
    if (signal.aborted) {
      const error = new Error('embedding aborted')
      error.name = 'AbortError'
      throw error
    }
    const embeddings = request.input.map((text) => vectorFor(text, this.#dimension))
    // A deterministic, plausible usage count (~4 chars per token), so the
    // ingestion path has a real number to settle the reservation against.
    const tokens = request.input.reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / 4)), 0)
    return { embeddings, model: request.model ?? this.#model, dimension: this.#dimension, tokens }
  }
}

/** A deterministic, distinct vector of `dimension` floats in [0, 1) for `text`. */
function vectorFor(text: string, dimension: number): number[] {
  let state = fnv1a(text)
  const out: number[] = []
  for (let i = 0; i < dimension; i++) {
    // mulberry32 step: deterministic, well-distributed, no external dependency.
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    out.push(((t ^ (t >>> 14)) >>> 0) / 4294967296)
  }
  return out
}

/** FNV-1a 32-bit hash: a stable seed per input string. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
