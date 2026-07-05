import { test } from '@japa/runner'
import OpenAICompatibleEmbeddingProvider from '../../../../src/providers/openai_compatible_embedding_provider.js'

/**
 * A real-API smoke for the OpenAI-compatible embedding provider. It exercises
 * the live `/embeddings` endpoint over the pinned `safeFetch` (the same path
 * production uses) when a key is configured, and self-skips otherwise so CI and
 * local runs stay green without a secret. Convention: a `*_real` spec hits a
 * live external dependency; everything else uses an in-process double.
 *
 * Configure via env: AI_EMBEDDING_API_KEY (required to run), AI_EMBEDDING_BASE_URL
 * (a full OpenAI-compatible base, e.g. https://api.openai.com/v1), AI_EMBEDDING_MODEL.
 */
const apiKey = process.env.AI_EMBEDDING_API_KEY
const baseUrl = process.env.AI_EMBEDDING_BASE_URL
const model = process.env.AI_EMBEDDING_MODEL

test.group('OpenAICompatibleEmbeddingProvider (real API)', (group) => {
  group.tap((t) =>
    t.skip(
      !apiKey || !baseUrl || !model,
      'set AI_EMBEDDING_API_KEY + AI_EMBEDDING_BASE_URL + AI_EMBEDDING_MODEL to run the embedding smoke'
    )
  )

  test('embeds a short text into a real vector', async ({ assert }) => {
    const provider = new OpenAICompatibleEmbeddingProvider(
      { name: 'openai-compatible', baseUrl: baseUrl!, defaultModel: model! },
      { apiKey: apiKey! }
    )
    const result = await provider.embed(
      { input: ['the quick brown fox'] },
      new AbortController().signal
    )
    assert.lengthOf(result.embeddings, 1)
    assert.isAbove(result.dimension, 0)
    assert.lengthOf(result.embeddings[0], result.dimension)
    assert.isTrue(result.embeddings[0].every((n) => Number.isFinite(n)))
  }).timeout(30_000)
})
