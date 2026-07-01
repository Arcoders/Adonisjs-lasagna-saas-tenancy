import { test } from '@japa/runner'
import { parseOpenAiStream } from '../../../../src/providers/wire/openai_sse.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { byteSource, collect } from '../../../helpers/sse_source.js'

function contentChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

test.group('openai_sse', () => {
  test('extracts content from choices[].delta.content', async ({ assert }) => {
    const fragments = await collect(
      parseOpenAiStream(byteSource(contentChunk('He'), contentChunk('llo'), 'data: [DONE]\n\n'))
    )
    assert.deepEqual(
      fragments.map((f) => f.data),
      ['He', 'llo']
    )
  })

  test('emits a usage fragment from the final completion_tokens', async ({ assert }) => {
    const source = byteSource(
      contentChunk('hi'),
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: 7 } })}\n\n`,
      'data: [DONE]\n\n'
    )
    const usage = (await collect(parseOpenAiStream(source))).filter((f) => f.event === 'usage')
    assert.deepEqual(
      usage.map((f) => f.tokens),
      [7]
    )
  })

  test('stops at the [DONE] sentinel', async ({ assert }) => {
    const fragments = await collect(
      parseOpenAiStream(byteSource(contentChunk('one'), 'data: [DONE]\n\n', contentChunk('after')))
    )
    assert.deepEqual(
      fragments.map((f) => f.data),
      ['one']
    )
  })

  test('reassembles a frame split across chunk boundaries', async ({ assert }) => {
    const frame = contentChunk('split-value')
    const mid = Math.floor(frame.length / 2)
    const fragments = await collect(
      parseOpenAiStream(byteSource(frame.slice(0, mid), frame.slice(mid), 'data: [DONE]\n\n'))
    )
    assert.deepEqual(
      fragments.map((f) => f.data),
      ['split-value']
    )
  })

  test('a malformed frame is skipped, not crashed', async ({ assert }) => {
    const fragments = await collect(
      parseOpenAiStream(byteSource('data: {broken\n\n', contentChunk('ok'), 'data: [DONE]\n\n'))
    )
    assert.deepEqual(
      fragments.map((f) => f.data),
      ['ok']
    )
  })

  test('an error payload becomes a sanitized AIException (no upstream body)', async ({
    assert,
  }) => {
    const source = byteSource(
      `data: ${JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'org sk-SECRET quota' } })}\n\n`
    )
    try {
      for await (const _f of parseOpenAiStream(source)) void _f
      assert.fail('expected a throw')
    } catch (err) {
      assert.instanceOf(err, AIException)
      assert.equal((err as AIException).aiCode, 'rate_limited')
      assert.notInclude((err as AIException).message, 'SECRET')
    }
  })

  test('DeepSeek and Kimi share this parser: identical shapes yield identical fragments', async ({
    assert,
  }) => {
    // Both are OpenAI-compatible, so a DeepSeek-style and a Kimi-style chunk of the
    // same shape parse identically. This is why one adapter serves both.
    const deepseek = await collect(
      parseOpenAiStream(byteSource(contentChunk('x'), 'data: [DONE]\n\n'))
    )
    const kimi = await collect(parseOpenAiStream(byteSource(contentChunk('x'), 'data: [DONE]\n\n')))
    assert.deepEqual(deepseek, kimi)
  })
})
