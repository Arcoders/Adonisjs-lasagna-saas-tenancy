import type { AIProviderName } from '../define_config.js'

/**
 * A single chat message handed to a provider. `content` is ALWAYS a string (an
 * assistant round that only invokes tools carries `''`), so every
 * `.content.length` bound holds without a content union. The tool fields are
 * optional and server-internal: `toolCalls` rides the assistant round the model
 * used to call tools, and role `'tool'` with `toolCallId` is a fenced, bounded
 * result turn the gateway authors between rounds. The client-facing parser
 * (`parseChatBody`) admits only `system|user|assistant` string content, so a
 * client can never submit `toolCalls` or a `'tool'` turn: every tool turn is
 * server-authored, which closes the forged-tool-result surface at the front door.
 */
export interface AIMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  /** Present on an assistant round that invoked tools; `content` may be `''`. Server-authored, never client-submitted. */
  readonly toolCalls?: readonly AIToolCall[]
  /** Present on a `role: 'tool'` result turn: the id of the {@link AIToolCall} this answers. Server-authored. */
  readonly toolCallId?: string
}

/**
 * One tool invocation the model emitted. `arguments` is the raw accumulated JSON
 * text exactly as the provider streamed it, validated later against the tool's
 * schema before any execution, never `any` and never pre-parsed here. `id`
 * correlates the later `role: 'tool'` result turn.
 */
export interface AIToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/**
 * A tool advertised to the model on a request. Wire-facing: `inputSchema` is the
 * JSON-Schema object the provider shows the model so it formats arguments;
 * `mode` marks a read tool (the default) apart from an `action` (mutating) tool,
 * a hard-gated, off-by-default capability. This is the tool's public shape; a
 * host's executable definition (handler, authorization) extends it server-side.
 */
export interface AIToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly mode?: 'read' | 'action'
}

/**
 * A request to stream a completion. `model` is a per-request override (validated
 * against the provider's `allowedModels`); `maxTokens` is the per-request output
 * cap that becomes the reservation worst case (config default applied when
 * omitted). Both are input, never class constants.
 */
export interface AIStreamRequest {
  readonly messages: readonly AIMessage[]
  readonly model?: string | undefined
  readonly maxTokens?: number
  /**
   * The tools advertised to the model this round. Present only on a tool-loop
   * request; absent leaves the provider serialization byte-for-byte a plain chat
   * call (zero overhead for non-tool chat). A provider whose `capabilities.tools`
   * is not `true` refuses a tools-carrying request rather than silently dropping.
   */
  readonly tools?: readonly AIToolDefinition[]
  /**
   * How the model may use the advertised tools: `'auto'` (the default when
   * `tools` is present) lets it choose, `'none'` forbids a call this round, and
   * `{ name }` forces one specific tool. Ignored when `tools` is absent.
   */
  readonly toolChoice?: 'auto' | 'none' | { readonly name: string }
}

/**
 * One streamed fragment. `data` is the raw token text; `tokens` is the cost of
 * this fragment and MUST be >= 0; `id` is an optional monotonic SSE id for
 * `Last-Event-ID` resume; `event` is an optional SSE event name (defaults to
 * `'token'`, with `'usage'` and `'tool_call'` reserved). Readonly: a provider
 * hands back immutable fragments.
 */
export interface StreamFragment {
  readonly data: string
  readonly tokens: number
  readonly id?: string
  readonly event?: string
  /**
   * Set when `event` is `'tool_call'`: the tool the model invoked this round.
   * `tokens` is 0 (generation is metered by the `usage` fragment); the tool loop
   * intercepts these between rounds and never streams `arguments` to the client
   * by default.
   */
  readonly toolCall?: AIToolCall
}

/** What a provider declares it can do. The registry gates on `streaming`. */
export interface AICapabilities {
  readonly streaming: boolean
  /**
   * Whether the provider understands tool / function calling (emits `tool_call`
   * fragments and serializes tool turns). Optional and defaults to absent; a
   * request carrying `tools` to a provider without `tools === true` fails closed
   * rather than silently dropping the tools.
   */
  readonly tools?: boolean
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
  readonly contractVersion?: number | undefined

  /**
   * What the provider can do. `streaming` MUST be `true`: the registry's
   * unconditional presence gate rejects a provider that does not declare it, so
   * a non-streaming provider can never degrade a streaming call at runtime.
   */
  readonly capabilities: AICapabilities

  /**
   * A stable, one-way fingerprint of the provider's active API key (never the
   * key itself), for the per-key request rate limit
   * (`ext:ai:<op>:<tenant>:<keyFingerprint>`, the denial-of-wallet defense) and audit attribution.
   * Optional: a provider that cannot expose one is keyed by its `name` instead.
   */
  readonly keyFingerprint?: string | undefined

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
