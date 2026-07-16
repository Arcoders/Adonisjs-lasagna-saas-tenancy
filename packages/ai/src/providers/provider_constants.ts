/**
 * Per-provider defaults. Base URLs, path suffixes, the Anthropic version header
 * and the default models are named constants here, never inlined at a call site,
 * and every one is overridable through `config.ai.<provider>` (base URL, model,
 * apiVersion) so nothing is hardcoded into behavior.
 */

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages'
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8'

export const OPENAI_CHAT_COMPLETIONS_PATH = '/chat/completions'
export const OPENAI_EMBEDDINGS_PATH = '/embeddings'

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat'

export const DEFAULT_KIMI_BASE_URL = 'https://api.moonshot.ai/v1'
export const DEFAULT_KIMI_MODEL = 'kimi-latest'
