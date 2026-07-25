import { test } from '@japa/runner'
import ClaudeProvider from '../../../../src/providers/claude_provider.js'
import {
  DeepSeekProvider,
  KimiProvider,
} from '../../../../src/providers/openai_compatible_provider.js'
import { fakeFetch, sseResponse } from '../../../helpers/fake_fetch.js'
import { collect } from '../../../helpers/sse_source.js'
import type { AIStreamRequest } from '../../../../src/types/ai_provider_contract.js'

const anthropicSse = [
  'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\n',
  'event: message_delta\ndata: {"usage":{"output_tokens":4}}\n\n',
  'event: message_stop\ndata: {}\n\n',
].join('')

const openaiSse = [
  'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
  'data: {"choices":[{"delta":{}}],"usage":{"completion_tokens":4}}\n\n',
  'data: [DONE]\n\n',
].join('')

const request: AIStreamRequest = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }

test.group('ClaudeProvider', () => {
  test('posts to the Anthropic Messages endpoint with the pinned headers and parses text', async ({
    assert,
  }) => {
    const { deps, calls } = fakeFetch(() => sseResponse(anthropicSse))
    const provider = new ClaudeProvider({ apiKey: 'sk-key' }, deps)
    const fragments = await collect(provider.stream(request, new AbortController().signal))

    assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages')
    assert.equal(calls[0]!.opts.headers?.['x-api-key'], 'sk-key')
    assert.equal(calls[0]!.opts.headers?.['anthropic-version'], '2023-06-01')
    assert.isTrue(calls[0]!.opts.streaming)
    assert.deepEqual(
      fragments.filter((f) => f.event !== 'usage').map((f) => f.data),
      ['Hi']
    )
    assert.equal(fragments.find((f) => f.event === 'usage')?.tokens, 4)
  })

  test('the request model overrides the config default; the body carries max_tokens', async ({
    assert,
  }) => {
    const { deps, calls } = fakeFetch(() => sseResponse(anthropicSse))
    const provider = new ClaudeProvider({ apiKey: 'k', defaultModel: 'claude-haiku-4-5' }, deps)
    await collect(
      provider.stream({ ...request, model: 'claude-opus-4-8' }, new AbortController().signal)
    )
    const body = JSON.parse(calls[0]!.opts.body as string)
    assert.equal(body.model, 'claude-opus-4-8')
    assert.equal(body.max_tokens, 100)
    assert.isTrue(body.stream)
  })

  test('a config baseUrl override is honored (BYOK / self-host)', async ({ assert }) => {
    const { deps, calls } = fakeFetch(() => sseResponse(anthropicSse))
    const provider = new ClaudeProvider({ apiKey: 'k', baseUrl: 'https://proxy.example.com' }, deps)
    await collect(provider.stream(request, new AbortController().signal))
    assert.equal(calls[0]!.url, 'https://proxy.example.com/v1/messages')
  })
})

test.group('OpenAI-compatible providers (DeepSeek + Kimi)', () => {
  test('DeepSeek posts Bearer auth to its chat-completions endpoint and parses content', async ({
    assert,
  }) => {
    const { deps, calls } = fakeFetch(() => sseResponse(openaiSse))
    const provider = new DeepSeekProvider({ apiKey: 'ds-key' }, deps)
    const fragments = await collect(provider.stream(request, new AbortController().signal))
    assert.equal(calls[0]!.url, 'https://api.deepseek.com/chat/completions')
    assert.equal(calls[0]!.opts.headers?.['authorization'], 'Bearer ds-key')
    assert.deepEqual(
      fragments.filter((f) => f.event !== 'usage').map((f) => f.data),
      ['Hi']
    )
  })

  test('Kimi differs from DeepSeek only by base URL and default model', async ({ assert }) => {
    const { deps: dsDeps, calls: dsCalls } = fakeFetch(() => sseResponse(openaiSse))
    const { deps: kimiDeps, calls: kimiCalls } = fakeFetch(() => sseResponse(openaiSse))
    const ds = await collect(
      new DeepSeekProvider({ apiKey: 'k' }, dsDeps).stream(request, new AbortController().signal)
    )
    const kimi = await collect(
      new KimiProvider({ apiKey: 'k' }, kimiDeps).stream(request, new AbortController().signal)
    )
    assert.equal(kimiCalls[0]!.url, 'https://api.moonshot.ai/v1/chat/completions')
    assert.notEqual(dsCalls[0]!.url, kimiCalls[0]!.url)
    // Same wire format => identical fragments through the shared adapter.
    assert.deepEqual(ds, kimi)
    assert.equal(JSON.parse(dsCalls[0]!.opts.body as string).model, 'deepseek-chat')
    assert.equal(JSON.parse(kimiCalls[0]!.opts.body as string).model, 'kimi-latest')
  })
})
