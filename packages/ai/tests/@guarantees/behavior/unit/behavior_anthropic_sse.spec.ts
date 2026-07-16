import { test } from '@japa/runner'
import { parseAnthropicStream } from '../../../../src/providers/wire/anthropic_sse.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { byteSource, collect } from '../../../helpers/sse_source.js'

function textDelta(text: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text },
  })}\n\n`
}

test.group('anthropic_sse', () => {
  test('extracts text from content_block_delta events', async ({ assert }) => {
    const fragments = await collect(
      parseAnthropicStream(
        byteSource(textDelta('He'), textDelta('llo'), 'event: message_stop\ndata: {}\n\n')
      )
    )
    assert.deepEqual(
      fragments.map((f) => f.data),
      ['He', 'llo']
    )
    assert.isTrue(fragments.every((f) => f.tokens === 0))
  })

  test('emits usage fragments with the incremental output-token delta', async ({ assert }) => {
    const source = byteSource(
      textDelta('hi'),
      `event: message_delta\ndata: ${JSON.stringify({ usage: { output_tokens: 5 } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ usage: { output_tokens: 8 } })}\n\n`
    )
    const usage = (await collect(parseAnthropicStream(source))).filter((f) => f.event === 'usage')
    assert.deepEqual(
      usage.map((f) => f.tokens),
      [5, 3]
    )
  })

  test('reassembles a frame split across chunk boundaries', async ({ assert }) => {
    const frame = textDelta('split')
    const mid = Math.floor(frame.length / 2)
    const fragments = await collect(
      parseAnthropicStream(byteSource(frame.slice(0, mid), frame.slice(mid)))
    )
    assert.deepEqual(
      fragments.map((f) => f.data),
      ['split']
    )
  })

  test('stops at message_stop', async ({ assert }) => {
    const fragments = await collect(
      parseAnthropicStream(byteSource('event: message_stop\ndata: {}\n\n', textDelta('after')))
    )
    assert.lengthOf(fragments, 0)
  })

  test('a malformed data frame is skipped, not crashed', async ({ assert }) => {
    const fragments = await collect(
      parseAnthropicStream(
        byteSource('event: content_block_delta\ndata: {not json\n\n', textDelta('ok'))
      )
    )
    assert.deepEqual(
      fragments.map((f) => f.data),
      ['ok']
    )
  })

  test('an error event becomes a sanitized AIException (no upstream body)', async ({ assert }) => {
    const source = byteSource(
      `event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'SECRET-KEY-sk-leak in body' },
      })}\n\n`
    )
    await assert.rejects(async () => {
      for await (const _f of parseAnthropicStream(source)) void _f
    })
    try {
      for await (const _f of parseAnthropicStream(
        byteSource(
          `event: error\ndata: ${JSON.stringify({
            error: { type: 'rate_limit_error', message: 'SECRET-KEY-sk-leak' },
          })}\n\n`
        )
      )) {
        void _f
      }
      assert.fail('expected a throw')
    } catch (err) {
      assert.instanceOf(err, AIException)
      assert.equal((err as AIException).aiCode, 'rate_limited')
      assert.notInclude((err as AIException).message, 'SECRET-KEY')
    }
  })
})
