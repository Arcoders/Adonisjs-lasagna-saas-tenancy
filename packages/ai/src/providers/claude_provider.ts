import { HttpAiProvider, type AIProviderDeps, defaultAiProviderDeps } from './base_provider.js'
import { parseAnthropicStream } from './wire/anthropic_sse.js'
import {
  ANTHROPIC_MESSAGES_PATH,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_VERSION,
  DEFAULT_CLAUDE_MODEL,
} from './provider_constants.js'
import type { AIProviderConfig, AIProviderName } from '../define_config.js'
import type { AIStreamRequest, StreamFragment } from '../types/ai_provider_contract.js'

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
      messages: request.messages,
      stream: true,
    }
  }

  protected parseBody(source: AsyncIterable<Uint8Array>): AsyncIterable<StreamFragment> {
    return parseAnthropicStream(source)
  }
}
