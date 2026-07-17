import { test } from '@japa/runner'
import { SafeFetchError } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import ClaudeProvider from '../../../../src/providers/claude_provider.js'
import { DeepSeekProvider } from '../../../../src/providers/openai_compatible_provider.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { fakeFetch, sseResponse } from '../../../helpers/fake_fetch.js'
import { collect } from '../../../helpers/sse_source.js'
import type { AIStreamRequest } from '../../../../src/types/ai_provider_contract.js'

const request: AIStreamRequest = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iter) void _
}

test.group('providers: secret handling', () => {
  test('verifyConfig throws config_missing without a key (never a shared/env fallback)', async ({
    assert,
  }) => {
    const provider = new ClaudeProvider({ apiKey: '' })
    await assert.rejects(() => provider.verifyConfig())
    try {
      await provider.verifyConfig()
      assert.fail('expected a throw')
    } catch (err) {
      assert.instanceOf(err, AIException)
      assert.equal((err as AIException).aiCode, 'config_missing')
    }
  })

  test('a canary key never appears in a stream fragment', async ({ assert }) => {
    const canary = 'sk-CANARY-do-not-leak'
    const { deps } = fakeFetch(() =>
      sseResponse(
        'event: content_block_delta\ndata: {"delta":{"text":"ok"}}\n\nevent: message_stop\ndata: {}\n\n'
      )
    )
    const provider = new ClaudeProvider({ apiKey: canary }, deps)
    const fragments = await collect(provider.stream(request, new AbortController().signal))
    for (const f of fragments) assert.notInclude(f.data, canary)
  })
})

test.group('providers: SSRF boundary', () => {
  test('the adapter never passes trustedHost or allowLoopback to the transport', async ({
    assert,
  }) => {
    const { deps, calls } = fakeFetch(() =>
      sseResponse('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n')
    )
    await collect(
      new DeepSeekProvider({ apiKey: 'k' }, deps).stream(request, new AbortController().signal)
    )
    assert.isUndefined(calls[0]!.opts.trustedHost)
    assert.isUndefined(calls[0]!.opts.allowLoopback)
    assert.isTrue(calls[0]!.opts.streaming)
  })

  test('a pin rejection of a BYOK endpoint surfaces as byok_endpoint_blocked', async ({
    assert,
  }) => {
    const { deps } = fakeFetch(() => {
      throw new SafeFetchError('url_blocks_private', 'refusing a private target')
    })
    const provider = new ClaudeProvider({ apiKey: 'k', baseUrl: 'https://internal.example' }, deps)
    try {
      await drain(provider.stream(request, new AbortController().signal))
      assert.fail('expected a throw')
    } catch (err) {
      assert.instanceOf(err, AIException)
      assert.equal((err as AIException).aiCode, 'byok_endpoint_blocked')
      assert.isFalse((err as AIException).isRetryable())
    }
  })

  test('a model outside the per-provider allow-list is rejected (G12 model scope)', async ({
    assert,
  }) => {
    const { deps } = fakeFetch(() => sseResponse('data: [DONE]\n\n'))
    const provider = new DeepSeekProvider({ apiKey: 'k', allowedModels: ['deepseek-chat'] }, deps)
    try {
      await drain(
        provider.stream({ ...request, model: 'deepseek-reasoner' }, new AbortController().signal)
      )
      assert.fail('expected a throw')
    } catch (err) {
      assert.instanceOf(err, AIException)
      assert.equal((err as AIException).aiCode, 'provider_not_allowed')
    }
  })
})
