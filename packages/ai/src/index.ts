export { defineAiConfig } from './define_config.js'
export type {
  AiConfig,
  AIEmbeddingConfig,
  AIProviderConfig,
  AIProviderName,
  MultitenancyConfigWithAi,
} from './define_config.js'
export { assertAiConfig } from './validate_config.js'
export { DEFAULT_AI_PROVIDER, DEFAULT_HEARTBEAT_MS } from './constants.js'

export { AI_CONTRACT_VERSION } from './sdk/contract_version.js'
export { default as AIProviderRegistry } from './services/ai_provider_registry.js'
export { resolveTenantProviderSelection } from './services/tenant_provider_selection.js'
export type { TenantProviderSelection } from './services/tenant_provider_selection.js'
export { default as AIException, AI_ERROR_CODES } from './exceptions/ai_exception.js'
export type { AIErrorCode } from './exceptions/ai_exception.js'
export type {
  AICapabilities,
  AIMessage,
  AIProviderContract,
  AIStreamRequest,
  StreamFragment,
} from './types/ai_provider_contract.js'
export type {
  AIEmbeddingCapabilities,
  AIEmbeddingProviderContract,
  AIEmbeddingRequest,
  AIEmbeddingResult,
} from './types/ai_embedding_contract.js'

export { default as ClaudeProvider } from './providers/claude_provider.js'
export {
  default as OpenAICompatibleProvider,
  DeepSeekProvider,
  KimiProvider,
} from './providers/openai_compatible_provider.js'
export type { OpenAICompatibleParams } from './providers/openai_compatible_provider.js'
export { HttpAiProvider, defaultAiProviderDeps } from './providers/base_provider.js'
export type { AIProviderDeps } from './providers/base_provider.js'
export { default as OpenAICompatibleEmbeddingProvider } from './providers/openai_compatible_embedding_provider.js'
export type { OpenAiEmbeddingParams } from './providers/openai_compatible_embedding_provider.js'

// The mount function itself lives on the './routes' subpath (it imports the
// Adonis router/app/logger service singletons, and THIS barrel must stay safe
// to import from config/multitenancy.ts, which loads before boot). Only the
// erased type surface is re-exported here.
export type {
  AiMiddlewareEntry,
  AiRouteMiddleware,
  MultitenancyAiRoutesOptions,
} from './routes/mount_gate.js'
export { aiMembershipGateRisk, isAbsentAiMiddleware } from './routes/mount_gate.js'
