import type { AIProviderName } from '../define_config.js'
import type {
  AICapabilities,
  AIProviderContract,
  AIStreamRequest,
  StreamFragment,
} from '../types/ai_provider_contract.js'

/** Construction options for {@link MockAIProvider}. */
export interface MockAIProviderOptions {
  /** Provider name. Default `'mock'`. */
  name?: AIProviderName
  /** The fragments the mock yields. Default one `hello` fragment costing one token. */
  fragments?: StreamFragment[]
  /** The declared contract version. Default undefined (registers with a warning). */
  contractVersion?: number
  /** Whether it declares streaming. Default `true`. Set `false` to test the presence gate. */
  streaming?: boolean
  /** When set, `verifyConfig()` rejects with this error. */
  verifyConfigError?: Error
  /** A canned key fingerprint for the per-key rate limit. Default undefined (keyed by name). */
  keyFingerprint?: string
}

/**
 * An in-process `AIProviderContract` for tests: an injectable fragment script
 * plus recorded calls for assertions. Yields its fragments respecting the abort
 * signal, so it drives the streaming service without a network. Exported from
 * `@adonisjs-lasagna/ai/testing`.
 */
export default class MockAIProvider implements AIProviderContract {
  readonly name: AIProviderName
  readonly contractVersion?: number
  readonly capabilities: AICapabilities
  readonly keyFingerprint?: string

  /** Every `stream()` call, in order, for assertions. */
  readonly calls: { request: AIStreamRequest }[] = []

  readonly #fragments: StreamFragment[]
  readonly #verifyConfigError?: Error

  constructor(opts: MockAIProviderOptions = {}) {
    this.name = opts.name ?? 'mock'
    this.contractVersion = opts.contractVersion
    this.capabilities = { streaming: opts.streaming ?? true }
    this.keyFingerprint = opts.keyFingerprint
    this.#fragments = opts.fragments ?? [{ data: 'hello', tokens: 1 }]
    this.#verifyConfigError = opts.verifyConfigError
  }

  async verifyConfig(): Promise<void> {
    if (this.#verifyConfigError) throw this.#verifyConfigError
  }

  async *stream(request: AIStreamRequest, signal: AbortSignal): AsyncIterable<StreamFragment> {
    this.calls.push({ request })
    for (const fragment of this.#fragments) {
      if (signal.aborted) return
      yield fragment
    }
  }
}
