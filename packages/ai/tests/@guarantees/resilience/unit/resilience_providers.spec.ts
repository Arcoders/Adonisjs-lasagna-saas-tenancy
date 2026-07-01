import { test } from '@japa/runner'
import { DeepSeekProvider } from '../../../../src/providers/openai_compatible_provider.js'
import ClaudeProvider from '../../../../src/providers/claude_provider.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { fakeFetch, sseResponse } from '../../../helpers/fake_fetch.js'
import type { AIStreamRequest } from '../../../../src/types/ai_provider_contract.js'

const request: AIStreamRequest = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }

async function firstError(iter: AsyncIterable<unknown>): Promise<unknown> {
  try {
    for await (const _ of iter) void _
    return undefined
  } catch (err) {
    return err
  }
}

test.group('providers: HTTP head classification (pre-first-byte)', () => {
  test('a 429 head throws rate_limited', async ({ assert }) => {
    const { deps } = fakeFetch(() => sseResponse('', 429))
    const err = await firstError(
      new DeepSeekProvider({ apiKey: 'k' }, deps).stream(request, new AbortController().signal)
    )
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'rate_limited')
  })

  test('a 5xx head throws provider_unavailable', async ({ assert }) => {
    const { deps } = fakeFetch(() => sseResponse('', 503))
    const err = await firstError(
      new ClaudeProvider({ apiKey: 'k' }, deps).stream(request, new AbortController().signal)
    )
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'provider_unavailable')
  })
})
