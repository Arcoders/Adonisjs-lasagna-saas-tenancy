import { test } from '@japa/runner'
import OpenAICompatibleEmbeddingProvider from '../../../../src/providers/openai_compatible_embedding_provider.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { fakeFetch, jsonResponse } from '../../../helpers/fake_fetch.js'

const params = {
  name: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  defaultModel: 'embed-1',
}

function embeddingsBody(vectors: number[][], model = 'embed-1', totalTokens = 12) {
  return {
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model,
    usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
  }
}

test.group('OpenAICompatibleEmbeddingProvider', () => {
  test('posts input to /embeddings with Bearer auth and float encoding, parses vectors', async ({
    assert,
  }) => {
    const { deps, calls } = fakeFetch(() =>
      jsonResponse(
        embeddingsBody([
          [0.1, 0.2],
          [0.3, 0.4],
        ])
      )
    )
    const provider = new OpenAICompatibleEmbeddingProvider(params, { apiKey: 'sk-key' }, deps)

    const result = await provider.embed({ input: ['a', 'b'] }, new AbortController().signal)

    assert.equal(calls[0]!.url, 'https://api.example.com/v1/embeddings')
    assert.equal(calls[0]!.opts.headers?.['authorization'], 'Bearer sk-key')
    assert.notProperty(calls[0]!.opts, 'streaming')
    const body = JSON.parse(calls[0]!.opts.body as string)
    assert.equal(body.model, 'embed-1')
    assert.equal(body.encoding_format, 'float')
    assert.deepEqual(body.input, ['a', 'b'])
    assert.deepEqual(result.embeddings, [
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    assert.equal(result.dimension, 2)
    assert.equal(result.tokens, 12)
  })

  test('reorders vectors by their index, never trusting array order', async ({ assert }) => {
    const scrambled = {
      data: [
        { index: 1, embedding: [9, 9] },
        { index: 0, embedding: [1, 1] },
      ],
      model: 'embed-1',
      usage: { total_tokens: 4 },
    }
    const { deps } = fakeFetch(() => jsonResponse(scrambled))
    const provider = new OpenAICompatibleEmbeddingProvider(params, { apiKey: 'k' }, deps)
    const result = await provider.embed(
      { input: ['first', 'second'] },
      new AbortController().signal
    )
    assert.deepEqual(result.embeddings, [
      [1, 1],
      [9, 9],
    ])
  })

  test('a config baseUrl override is honored (BYOK / self-host)', async ({ assert }) => {
    const { deps, calls } = fakeFetch(() => jsonResponse(embeddingsBody([[0.1]])))
    const provider = new OpenAICompatibleEmbeddingProvider(
      params,
      { apiKey: 'k', baseUrl: 'https://byok.example.com' },
      deps
    )
    await provider.embed({ input: ['x'] }, new AbortController().signal)
    assert.equal(calls[0]!.url, 'https://byok.example.com/embeddings')
  })

  test('a non-2xx maps to a typed AIException (429 -> rate_limited, else provider_unavailable)', async ({
    assert,
  }) => {
    const rate = fakeFetch(() => jsonResponse({}, 429))
    const p1 = new OpenAICompatibleEmbeddingProvider(params, { apiKey: 'k' }, rate.deps)
    await assert.rejects(() => p1.embed({ input: ['x'] }, new AbortController().signal), /HTTP 429/)

    const down = fakeFetch(() => jsonResponse({}, 503))
    const p2 = new OpenAICompatibleEmbeddingProvider(params, { apiKey: 'k' }, down.deps)
    await assert.rejects(() => p2.embed({ input: ['x'] }, new AbortController().signal), /HTTP 503/)
  })

  test('a SafeFetchError (SSRF pin) surfaces as byok_endpoint_blocked', async ({ assert }) => {
    const { SafeFetchError } = await import('@adonisjs-lasagna/saas-tenancy/safe-fetch')
    const deps = {
      async fetch() {
        throw new SafeFetchError('blocked', 'private_ip')
      },
    }
    const provider = new OpenAICompatibleEmbeddingProvider(params, { apiKey: 'k' }, deps)
    await assert.rejects(async () => {
      try {
        await provider.embed({ input: ['x'] }, new AbortController().signal)
      } catch (error) {
        assert.instanceOf(error, AIException)
        assert.equal((error as AIException).aiCode, 'byok_endpoint_blocked')
        throw error
      }
    })
  })

  test('a malformed response body is a provider_unavailable fault, not a silent bad vector', async ({
    assert,
  }) => {
    const { deps } = fakeFetch(() => jsonResponse({ data: [] }))
    const provider = new OpenAICompatibleEmbeddingProvider(params, { apiKey: 'k' }, deps)
    await assert.rejects(
      () => provider.embed({ input: ['x'] }, new AbortController().signal),
      /malformed embeddings/
    )
  })

  test('a model outside the allow-list is refused (G12) before any call', async ({ assert }) => {
    const { deps, calls } = fakeFetch(() => jsonResponse(embeddingsBody([[0.1]])))
    const provider = new OpenAICompatibleEmbeddingProvider(
      params,
      { apiKey: 'k', allowedModels: ['embed-1'] },
      deps
    )
    await assert.rejects(
      () => provider.embed({ input: ['x'], model: 'embed-secret' }, new AbortController().signal),
      /not allow-listed/
    )
    assert.lengthOf(calls, 0)
  })

  test('verifyConfig rejects a missing key with config_missing', async ({ assert }) => {
    const { deps } = fakeFetch(() => jsonResponse(embeddingsBody([[0.1]])))
    const provider = new OpenAICompatibleEmbeddingProvider(params, { apiKey: '' }, deps)
    await assert.rejects(() => provider.verifyConfig(), /api key is not configured/)
  })

  test('embedding with no model anywhere is an invalid_request', async ({ assert }) => {
    const { deps } = fakeFetch(() => jsonResponse(embeddingsBody([[0.1]])))
    const provider = new OpenAICompatibleEmbeddingProvider(
      { name: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
      { apiKey: 'k' },
      deps
    )
    await assert.rejects(
      () => provider.embed({ input: ['x'] }, new AbortController().signal),
      /require a model/
    )
  })
})
