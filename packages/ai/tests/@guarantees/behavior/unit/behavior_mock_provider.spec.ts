import { test } from '@japa/runner'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import type { StreamFragment } from '../../../../src/types/ai_provider_contract.js'

async function collect(iter: AsyncIterable<StreamFragment>): Promise<StreamFragment[]> {
  const out: StreamFragment[] = []
  for await (const f of iter) out.push(f)
  return out
}

test.group('MockAIProvider', () => {
  test('yields its scripted fragments and records the call', async ({ assert }) => {
    const provider = new MockAIProvider({
      fragments: [
        { data: 'he', tokens: 1 },
        { data: 'llo', tokens: 2 },
      ],
    })
    const request = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100 }
    const fragments = await collect(provider.stream(request, new AbortController().signal))
    assert.deepEqual(
      fragments.map((f) => f.data),
      ['he', 'llo']
    )
    assert.lengthOf(provider.calls, 1)
    assert.strictEqual(provider.calls[0]!.request, request)
  })

  test('stops yielding once the signal is aborted', async ({ assert }) => {
    const controller = new AbortController()
    controller.abort()
    const provider = new MockAIProvider({ fragments: [{ data: 'x', tokens: 1 }] })
    const fragments = await collect(provider.stream({ messages: [] }, controller.signal))
    assert.lengthOf(fragments, 0)
  })

  test('verifyConfig rejects when a failure is scripted', async ({ assert }) => {
    const ok = new MockAIProvider()
    await assert.doesNotReject(() => ok.verifyConfig())
    const bad = new MockAIProvider({ verifyConfigError: new Error('no key') })
    await assert.rejects(() => bad.verifyConfig(), 'no key')
  })
})
