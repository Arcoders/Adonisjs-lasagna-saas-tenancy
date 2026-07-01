import type { AIProviderContract } from '../types/ai_provider_contract.js'

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
