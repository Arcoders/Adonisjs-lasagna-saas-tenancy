import { HttpAiProvider, type AIProviderDeps, defaultAiProviderDeps } from './base_provider.js'
import { parseAnthropicStream } from './wire/anthropic_sse.js'
import {
  ANTHROPIC_MESSAGES_PATH,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_VERSION,
  DEFAULT_CLAUDE_MODEL,
} from './provider_constants.js'
import type { AIProviderConfig, AIProviderName } from '../define_config.js'
import type {
  AIMessage,
  AIStreamRequest,
  AIToolDefinition,
  StreamFragment,
} from '../types/ai_provider_contract.js'

/**
 * The Claude provider (Anthropic Messages SSE), the default. Streams through the
 * kernel's pinned fetch, with no vendor SDK (which would bypass the pin). Base
 * URL, model and the `anthropic-version` header are config-with-default.
 */
export default class ClaudeProvider extends HttpAiProvider {
  readonly name: AIProviderName = 'claude'

  constructor(cfg: AIProviderConfig, deps: AIProviderDeps = defaultAiProviderDeps) {
    super(cfg, deps, DEFAULT_CLAUDE_MODEL)
  }

  protected endpoint(): string {
    return `${this.cfg.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL}${ANTHROPIC_MESSAGES_PATH}`
  }

  protected headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.cfg.apiKey,
      'anthropic-version': this.cfg.apiVersion ?? DEFAULT_ANTHROPIC_VERSION,
    }
  }

  protected requestBody(request: AIStreamRequest, model: string): unknown {
    return {
      model,
      max_tokens: request.maxTokens,
      messages: request.messages.map(toAnthropicMessage),
      stream: true,
      // Tool fields are added only when the request carries tools, so a plain
      // chat call serializes byte-for-byte as before (zero overhead).
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map(toAnthropicTool),
            tool_choice: toAnthropicToolChoice(request.toolChoice),
          }
        : {}),
    }
  }

  protected parseBody(source: AsyncIterable<Uint8Array>): AsyncIterable<StreamFragment> {
    return parseAnthropicStream(source)
  }
}

/** Map an {@link AIToolDefinition} to the Anthropic Messages `tools[]` shape. Pure. */
export function toAnthropicTool(tool: AIToolDefinition): unknown {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema }
}

/** Map the contract `toolChoice` to Anthropic's `tool_choice`, defaulting to `{ type: 'auto' }`. Pure. */
export function toAnthropicToolChoice(choice: AIStreamRequest['toolChoice']): unknown {
  if (choice === 'none') return { type: 'none' }
  if (choice && typeof choice === 'object') return { type: 'tool', name: choice.name }
  return { type: 'auto' }
}

/**
 * Map an {@link AIMessage} to Anthropic's message shape. Plain messages pass
 * through as `{ role, content }` (including a host system prompt, unchanged). An
 * assistant tool-call turn becomes a `tool_use` content array, and a `role: 'tool'`
 * result becomes a `user` message with a `tool_result` block (the dialect has no
 * tool role). Pure.
 */
export function toAnthropicMessage(message: AIMessage): unknown {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
      ],
    }
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    const content: unknown[] = []
    if (message.content.length > 0) content.push({ type: 'text', text: message.content })
    for (const call of message.toolCalls) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolInput(call.arguments) })
    }
    return { role: 'assistant', content }
  }
  return { role: message.role, content: message.content }
}

/** Anthropic's `tool_use.input` must be a JSON object; parse the accumulated argument text, defaulting to `{}`. */
function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
