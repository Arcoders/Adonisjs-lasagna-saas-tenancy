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
  /**
   * Tool-scripted mode: one entry per `stream()` call, so a multi-round tool
   * loop can drive the mock offline. Call N yields `rounds[N]` (the last entry
   * repeats once exhausted); a round emits a `tool_call` fragment
   * (`{ event: 'tool_call', toolCall, tokens: 0 }`) to make the loop re-enter,
   * then a plain text round to finish. When set it takes precedence over
   * `fragments` and defaults `capabilities.tools` to `true`.
   */
  rounds?: StreamFragment[][]
  /** Whether it declares tool / function calling. Defaults to `true` when `rounds` is set, else absent. */
  tools?: boolean
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
  readonly contractVersion?: number | undefined
  readonly capabilities: AICapabilities
  readonly keyFingerprint?: string | undefined

  /** Every `stream()` call, in order, for assertions. */
  readonly calls: { request: AIStreamRequest }[] = []

  readonly #fragments: StreamFragment[]
  readonly #rounds?: StreamFragment[][] | undefined
  readonly #verifyConfigError?: Error | undefined

  constructor(opts: MockAIProviderOptions = {}) {
    this.name = opts.name ?? 'mock'
    this.contractVersion = opts.contractVersion
    const streaming = opts.streaming ?? true
    const declaresTools = opts.tools ?? (opts.rounds !== undefined ? true : undefined)
    this.capabilities =
      declaresTools === undefined ? { streaming } : { streaming, tools: declaresTools }
    this.keyFingerprint = opts.keyFingerprint
    this.#fragments = opts.fragments ?? [{ data: 'hello', tokens: 1 }]
    this.#rounds = opts.rounds
    this.#verifyConfigError = opts.verifyConfigError
  }

  async verifyConfig(): Promise<void> {
    if (this.#verifyConfigError) throw this.#verifyConfigError
  }

  async *stream(request: AIStreamRequest, signal: AbortSignal): AsyncIterable<StreamFragment> {
    // Pick this round's script BEFORE recording the call, so round index N maps
    // to the N-th `stream()` invocation; the last round repeats once exhausted.
    const round = this.#rounds
      ? (this.#rounds[Math.min(this.calls.length, this.#rounds.length - 1)] ?? [])
      : this.#fragments
    this.calls.push({ request })
    for (const fragment of round) {
      if (signal.aborted) return
      yield fragment
    }
  }
}
