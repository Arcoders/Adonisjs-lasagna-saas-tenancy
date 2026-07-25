import { test } from '@japa/runner'
import EmbeddingProviderRegistry from '../../../../src/services/embedding_provider_registry.js'
import OpenAICompatibleEmbeddingProvider from '../../../../src/providers/openai_compatible_embedding_provider.js'
import MockEmbeddingProvider from '../../../../src/testing/mock_embedding_provider.js'
import type { AIEmbeddingConfig } from '../../../../src/define_config.js'

/**
 * The embedding-provider override registry. With no host override it
 * builds the configured OpenAI-compatible backend (byte-identical to the pre-seam
 * inline construction); a registered override supersedes it; clear() restores the
 * default. Mirrors the chat AIProviderRegistry for the single embedding provider.
 */
const cfg = {
  provider: 'openai-compatible',
  apiKey: 'k',
  baseUrl: 'https://embeddings.example',
  dimension: 8,
} as unknown as AIEmbeddingConfig

test.group('behavior: embedding provider registry', () => {
  test('with no override, resolve builds the configured OpenAI-compatible provider', ({
    assert,
  }) => {
    const reg = new EmbeddingProviderRegistry()
    assert.isFalse(reg.has())
    assert.instanceOf(reg.resolve(cfg), OpenAICompatibleEmbeddingProvider)
  })

  test('a registered override supersedes the default and is returned by resolve', ({ assert }) => {
    const reg = new EmbeddingProviderRegistry()
    const mock = new MockEmbeddingProvider({ dimension: 8 })
    assert.strictEqual(reg.register(mock), reg, 'register is chainable')
    assert.isTrue(reg.has())
    assert.strictEqual(reg.resolve(cfg), mock)
  })

  test('clear drops the override, restoring the configured default', ({ assert }) => {
    const reg = new EmbeddingProviderRegistry()
    reg.register(new MockEmbeddingProvider({ dimension: 8 }))
    assert.strictEqual(reg.clear(), reg, 'clear is chainable')
    assert.isFalse(reg.has())
    assert.instanceOf(reg.resolve(cfg), OpenAICompatibleEmbeddingProvider)
  })
})
