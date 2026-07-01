import type { AIProviderName } from '../define_config.js'

/** A single chat message handed to a provider. */
export interface AIMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/**
 * A request to stream a completion. `model` is a per-request override (validated
 * against the provider's `allowedModels`); `maxTokens` is the per-request output
 * cap that becomes the reservation worst case (config default applied when
 * omitted). Both are input, never class constants.
 */
export interface AIStreamRequest {
  readonly messages: readonly AIMessage[]
  readonly model?: string
  readonly maxTokens?: number
}

/**
 * One streamed fragment. `data` is the raw token text; `tokens` is the cost of
 * this fragment and MUST be >= 0; `id` is an optional monotonic SSE id for
 * `Last-Event-ID` resume; `event` is an optional SSE event name (defaults to
 * `'token'`). Readonly: a provider hands back immutable fragments.
 */
export interface StreamFragment {
  readonly data: string
  readonly tokens: number
  readonly id?: string
  readonly event?: string
}

/** What a provider declares it can do. The registry gates on `streaming`. */
export interface AICapabilities {
  readonly streaming: boolean
}

/**
 * The contract every AI provider satisfies. A provider encapsulates one model
 * vendor's wire format and streams a completion as an async iterable of
 * fragments. It is the public extension seam: a host implements it to add a
 * provider, registers it on `AIProviderRegistry`, and allow-lists it per tenant.
 * It mirrors `BillingProviderContract`, with a per-tenant selection model and a
 * streaming-presence gate instead of billing's version-only check.
 */
export interface AIProviderContract {
  /** The provider's stable name (matches an `allowedProviders` entry / a config block). */
  readonly name: AIProviderName

  /**
   * The contract version this provider was built against (see
   * `AI_CONTRACT_VERSION`). Absent registers with a one-time "unversioned"
   * warning, never a failure; declare it to opt into the compatibility check.
   */
  readonly contractVersion?: number

  /**
   * What the provider can do. `streaming` MUST be `true`: the registry's
   * unconditional presence gate rejects a provider that does not declare it, so
   * a non-streaming provider can never degrade a streaming call at runtime.
   */
  readonly capabilities: AICapabilities

  /**
   * Boot-time validation of the provider's config slice (key presence, and for
   * a BYOK `baseUrl` the endpoint against the SSRF guard). Runs from
   * `AiProvider.boot()` so a missing key fails at boot, not at the first stream.
   */
  verifyConfig(): Promise<void>

  /**
   * Stream a completion. Yields `StreamFragment`s until the model stops. The
   * `signal` is the composed abort (timeout, liveness, client disconnect,
   * budget early-stop); the provider MUST stop pulling and release its transport
   * when it fires. Implementations stream over the kernel's IP-pinned fetch, so
   * every AI-initiated URL stays SSRF-checked.
   */
  stream(request: AIStreamRequest, signal: AbortSignal): AsyncIterable<StreamFragment>
}
