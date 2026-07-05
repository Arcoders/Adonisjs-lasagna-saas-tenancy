import type { AIProviderContract } from '../types/ai_provider_contract.js'
import type { AIEmbeddingProviderContract } from '../types/ai_embedding_contract.js'

/**
 * A pure conformance check every AI provider must pass, shipped so satellite
 * authors can gate their own provider in a unit spec: assert the returned list
 * is empty. It checks the load-bearing shape (a name, the streaming capability
 * the registry gates on, and the two required methods) without a network.
 */
export function checkAIProviderConformance(provider: AIProviderContract): string[] {
  const problems: string[] = []
  if (typeof provider.name !== 'string' || provider.name.length === 0) {
    problems.push('provider.name must be a non-empty string')
  }
  if (provider.capabilities?.streaming !== true) {
    problems.push(
      'provider.capabilities.streaming must be true (the registry presence gate rejects otherwise)'
    )
  }
  if (typeof provider.verifyConfig !== 'function') {
    problems.push('provider.verifyConfig must be a function')
  }
  if (typeof provider.stream !== 'function') {
    problems.push('provider.stream must be a function')
  }
  return problems
}

/**
 * The embedding-provider mirror of {@link checkAIProviderConformance}: the
 * load-bearing shape (a name, the embedding capability, and the two required
 * methods) without a network, so a satellite author can gate a custom
 * embedding backend in a unit spec by asserting the returned list is empty.
 */
export function checkAIEmbeddingProviderConformance(
  provider: AIEmbeddingProviderContract
): string[] {
  const problems: string[] = []
  if (typeof provider.name !== 'string' || provider.name.length === 0) {
    problems.push('provider.name must be a non-empty string')
  }
  if (provider.capabilities?.embedding !== true) {
    problems.push('provider.capabilities.embedding must be true')
  }
  if (typeof provider.verifyConfig !== 'function') {
    problems.push('provider.verifyConfig must be a function')
  }
  if (typeof provider.embed !== 'function') {
    problems.push('provider.embed must be a function')
  }
  return problems
}
