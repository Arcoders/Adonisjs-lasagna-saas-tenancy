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
import type { AIStreamRequest, StreamFragment } from '../types/ai_provider_contract.js'

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
      messages: request.messages,
      stream: true,
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
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
