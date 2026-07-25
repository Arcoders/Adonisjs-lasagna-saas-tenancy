import { HttpAiProvider, type AIProviderDeps, defaultAiProviderDeps } from './base_provider.js'
import { parseOpenAiStream } from './wire/openai_sse.js'
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_KIMI_BASE_URL,
  DEFAULT_KIMI_MODEL,
  OPENAI_CHAT_COMPLETIONS_PATH,
} from './provider_constants.js'
import type { AIProviderConfig, AIProviderName } from '../define_config.js'
import type {
  AICapabilities,
  AIMessage,
  AIStreamRequest,
  AIToolDefinition,
  StreamFragment,
} from '../types/ai_provider_contract.js'

/** The built-in identity of an OpenAI-compatible provider (its name + public endpoint + model). */
export interface OpenAICompatibleParams {
  name: AIProviderName
  baseUrl: string
  defaultModel: string
}

/**
 * A provider for any OpenAI-compatible chat-completions endpoint (DeepSeek, Kimi,
 * and self-hosted). One adapter serves them all because they share the wire
 * format; only the name, base URL and default model differ. Streams through the
 * kernel's pinned fetch with no vendor SDK. Base URL and model are config-with-default.
 */
export default class OpenAICompatibleProvider extends HttpAiProvider {
  readonly name: AIProviderName
  // The OpenAI-compatible dialect serializes tool definitions and tool turns
  // (toOpenAiTool / toOpenAiMessage), so DeepSeek, Kimi and self-hosted backends
  // declare the optional tool-calling capability. The chat controller refuses a
  // tool loop against a provider that does not, never a silent drop.
  override readonly capabilities: AICapabilities = { streaming: true, tools: true }
  readonly #baseUrl: string

  constructor(
    params: OpenAICompatibleParams,
    cfg: AIProviderConfig,
    deps: AIProviderDeps = defaultAiProviderDeps
  ) {
    super(cfg, deps, params.defaultModel)
    this.name = params.name
    this.#baseUrl = cfg.baseUrl ?? params.baseUrl
  }

  protected endpoint(): string {
    return `${this.#baseUrl}${OPENAI_CHAT_COMPLETIONS_PATH}`
  }

  protected headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.cfg.apiKey}`,
    }
  }

  protected requestBody(request: AIStreamRequest, model: string): unknown {
    return {
      model,
      messages: request.messages.map(toOpenAiMessage),
      stream: true,
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      // Tool fields are added only when the request carries tools, so a plain
      // chat call serializes byte-for-byte as before (zero overhead).
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map(toOpenAiTool),
            tool_choice: toOpenAiToolChoice(request.toolChoice),
          }
        : {}),
      stream_options: { include_usage: true },
    }
  }

  protected parseBody(source: AsyncIterable<Uint8Array>): AsyncIterable<StreamFragment> {
    return parseOpenAiStream(source)
  }
}

/** DeepSeek (`deepseek-chat`), an OpenAI-compatible provider. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(cfg: AIProviderConfig, deps: AIProviderDeps = defaultAiProviderDeps) {
    super(
      {
        name: 'deepseek',
        baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
        defaultModel: DEFAULT_DEEPSEEK_MODEL,
      },
      cfg,
      deps
    )
  }
}

/** Kimi / Moonshot (`kimi-latest`), an OpenAI-compatible provider. */
export class KimiProvider extends OpenAICompatibleProvider {
  constructor(cfg: AIProviderConfig, deps: AIProviderDeps = defaultAiProviderDeps) {
    super(
      { name: 'kimi', baseUrl: DEFAULT_KIMI_BASE_URL, defaultModel: DEFAULT_KIMI_MODEL },
      cfg,
      deps
    )
  }
}

/** Map an {@link AIToolDefinition} to the OpenAI `tools[]` function shape. Pure. */
export function toOpenAiTool(tool: AIToolDefinition): unknown {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }
}

/** Map the contract `toolChoice` to OpenAI's `tool_choice`, defaulting to `'auto'`. Pure. */
export function toOpenAiToolChoice(choice: AIStreamRequest['toolChoice']): unknown {
  if (choice === 'none') return 'none'
  if (choice && typeof choice === 'object') {
    return { type: 'function', function: { name: choice.name } }
  }
  return 'auto'
}

/**
 * Map an {@link AIMessage} to OpenAI's message shape. Plain messages pass through
 * as `{ role, content }`. An assistant tool-call turn carries `tool_calls[]`
 * (each `function.arguments` staying the raw JSON string), and a `role: 'tool'`
 * result becomes `{ role: 'tool', tool_call_id, content }`. Pure.
 */
export function toOpenAiMessage(message: AIMessage): unknown {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    }
  }
  return { role: message.role, content: message.content }
}
