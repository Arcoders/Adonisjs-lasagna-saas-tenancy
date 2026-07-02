import { test } from '@japa/runner'
import MockEmbeddingProvider from '../../../../src/testing/mock_embedding_provider.js'
import { checkAIEmbeddingProviderConformance } from '../../../../src/testing/conformance.js'

test.group('MockEmbeddingProvider', () => {
  test('embeds each input into a vector of the declared dimension, in order', async ({
    assert,
  }) => {
    const provider = new MockEmbeddingProvider({ dimension: 16 })
    const request = { input: ['alpha', 'beta', 'gamma'] }
    const result = await provider.embed(request, new AbortController().signal)

    assert.lengthOf(result.embeddings, 3)
    for (const vector of result.embeddings) {
      assert.lengthOf(vector, 16)
      assert.isTrue(vector.every((n) => Number.isFinite(n)))
    }
    assert.strictEqual(result.dimension, 16)
    assert.isAbove(result.tokens, 0)
    assert.lengthOf(provider.calls, 1)
    assert.strictEqual(provider.calls[0].request, request)
  })

  test('is deterministic: same text yields the same vector across instances', async ({
    assert,
  }) => {
    const a = new MockEmbeddingProvider({ dimension: 8 })
    const b = new MockEmbeddingProvider({ dimension: 8 })
    const signal = new AbortController().signal
    const one = await a.embed({ input: ['hola amigo'] }, signal)
    const two = await b.embed({ input: ['hola amigo'] }, signal)
    assert.deepEqual(one.embeddings[0], two.embeddings[0])
  })

  test('distinct inputs yield distinct vectors, aligned to input order', async ({ assert }) => {
    const provider = new MockEmbeddingProvider({ dimension: 8 })
    const result = await provider.embed(
      { input: ['first', 'second'] },
      new AbortController().signal
    )
    assert.notDeepEqual(result.embeddings[0], result.embeddings[1])
  })

  test('rejects when the signal is already aborted', async ({ assert }) => {
    const controller = new AbortController()
    controller.abort()
    const provider = new MockEmbeddingProvider()
    await assert.rejects(() => provider.embed({ input: ['x'] }, controller.signal))
  })

  test('verifyConfig rejects when a failure is scripted', async ({ assert }) => {
    const ok = new MockEmbeddingProvider()
    await assert.doesNotReject(() => ok.verifyConfig())
    const bad = new MockEmbeddingProvider({ verifyConfigError: new Error('no key') })
    await assert.rejects(() => bad.verifyConfig(), 'no key')
  })

  test('passes the embedding conformance check', ({ assert }) => {
    assert.deepEqual(checkAIEmbeddingProviderConformance(new MockEmbeddingProvider()), [])
  })

  test('a provider that does not declare the embedding capability fails conformance', ({
    assert,
  }) => {
    const problems = checkAIEmbeddingProviderConformance(
      new MockEmbeddingProvider({ embedding: false })
    )
    assert.isAbove(problems.length, 0)
  })
})
