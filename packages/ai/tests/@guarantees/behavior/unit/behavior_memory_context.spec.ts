import { test } from '@japa/runner'
import {
  injectMemoryTurns,
  reconstructAssistantText,
} from '../../../../src/gateway/context_builder.js'
import SseWriter from '../../../../src/gateway/sse_writer.js'
import type { AIMessage, StreamFragment } from '../../../../src/types/ai_provider_contract.js'
import type { ConversationTurn } from '../../../../src/services/conversation_memory_service.js'
import { FakeSseSink } from '../../../helpers/fake_sse_sink.js'

/**
 * The pure memory-context helpers: `injectMemoryTurns` prepends prior
 * turns as bounded DATA after any leading system prompt, and
 * `reconstructAssistantText` inverts the SSE writer to recover the assistant's
 * text for persistence.
 */

const u = (content: string): ConversationTurn => ({ role: 'user', content })
const a = (content: string): ConversationTurn => ({ role: 'assistant', content })
const big = { maxTurns: 50, maxChars: 100_000 }

test.group('behavior: injectMemoryTurns', () => {
  test('prepends prior turns before the current turn, keeping roles (never system)', ({
    assert,
  }) => {
    const out = injectMemoryTurns([{ role: 'user', content: 'now' }], [u('q1'), a('a1')], big)
    assert.deepEqual(out, [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'now' },
    ])
    assert.isFalse(out.some((m) => m.role === 'system'))
  })

  test('inserts AFTER a leading client system prompt (a system turn keeps the lead)', ({
    assert,
  }) => {
    const messages: AIMessage[] = [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'now' },
    ]
    const out = injectMemoryTurns(messages, [u('q1'), a('a1')], big)
    assert.deepEqual(out, [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'now' },
    ])
  })

  test('drops the oldest exchanges to fit maxChars', ({ assert }) => {
    // Three exchanges, 20 chars each (2 turns x 10). Budget 25 holds only the newest.
    const prior = [
      u('x'.repeat(10)),
      a('y'.repeat(10)),
      u('z'.repeat(10)),
      a('w'.repeat(10)),
      u('p'.repeat(10)),
      a('q'.repeat(10)),
    ]
    const out = injectMemoryTurns([{ role: 'user', content: 'now' }], prior, {
      maxTurns: 50,
      maxChars: 25,
    })
    assert.deepEqual(out, [
      { role: 'user', content: 'p'.repeat(10) },
      { role: 'assistant', content: 'q'.repeat(10) },
      { role: 'user', content: 'now' },
    ])
  })

  test('keeps only the newest maxTurns exchanges', ({ assert }) => {
    const prior = [u('q1'), a('a1'), u('q2'), a('a2'), u('q3'), a('a3')]
    const out = injectMemoryTurns([{ role: 'user', content: 'now' }], prior, {
      maxTurns: 1,
      maxChars: 100_000,
    })
    assert.deepEqual(out, [
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'now' },
    ])
  })

  test('truncates a single oversized exchange rather than blanking memory', ({ assert }) => {
    const out = injectMemoryTurns(
      [{ role: 'user', content: 'now' }],
      [u('x'.repeat(100)), a('y'.repeat(100))],
      {
        maxTurns: 50,
        maxChars: 10,
      }
    )
    // Share = floor(10 / 2) = 5 chars per turn.
    assert.deepEqual(out, [
      { role: 'user', content: 'x'.repeat(5) },
      { role: 'assistant', content: 'y'.repeat(5) },
      { role: 'user', content: 'now' },
    ])
  })

  test('a non-positive budget injects nothing', ({ assert }) => {
    const messages: AIMessage[] = [{ role: 'user', content: 'now' }]
    assert.deepEqual(
      injectMemoryTurns(messages, [u('q'), a('a')], { maxTurns: 5, maxChars: 0 }),
      messages
    )
  })

  test('no prior turns leaves the messages unchanged', ({ assert }) => {
    const messages: AIMessage[] = [{ role: 'user', content: 'now' }]
    assert.deepEqual(injectMemoryTurns(messages, [], big), messages)
  })
})

test.group('behavior: reconstructAssistantText', () => {
  // The SSE serialization only reads data + event, so the cases supply just that
  // subset and we complete it to a valid StreamFragment (tokens is metering metadata
  // writeFragment never touches) at the write boundary.
  async function framesFor(
    fragments: Array<Pick<StreamFragment, 'data' | 'event'>>
  ): Promise<string[]> {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    for (const fragment of fragments) await writer.writeFragment({ tokens: 0, ...fragment })
    return sink.writes
  }

  test('round-trips the concatenated token stream, including multi-line fragments', async ({
    assert,
  }) => {
    const frames = await framesFor([{ data: 'Hello' }, { data: ' world' }, { data: 'multi\nline' }])
    assert.equal(reconstructAssistantText(frames), 'Hello worldmulti\nline')
  })

  test('skips control frames (error / done)', async ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    await writer.writeFragment({ data: 'answer', tokens: 0 })
    await writer.writeErrorEvent('over_budget')
    sink.write('event: done\ndata: {"outcome":"completed"}\n\n')
    assert.equal(reconstructAssistantText(sink.writes), 'answer')
  })

  test('no content frames yields an empty string', ({ assert }) => {
    assert.equal(reconstructAssistantText(['event: done\ndata: x\n\n']), '')
  })

  test('skips tool_call notices (memory holds the answer, never tool activity)', async ({
    assert,
  }) => {
    // A round that streamed some text, emitted a redacted tool_call notice, then
    // finished the answer. Persisted memory must be the natural-language answer
    // only, never the {name,id} tool marker.
    const frames = await framesFor([
      { data: 'Tienes ' },
      { data: '{"name":"count_bookings","id":"c1"}', event: 'tool_call' },
      { data: '4 reservas.' },
    ])
    const text = reconstructAssistantText(frames)
    assert.equal(text, 'Tienes 4 reservas.')
    assert.notInclude(text, 'count_bookings')
  })

  test('an UNKNOWN control event is excluded without being enumerated here', async ({ assert }) => {
    // The property that a deny-list cannot give: this event does not exist yet.
    // Memory feeds the next prompt, so a new control frame must be inert the day
    // it is added rather than the day someone remembers to skip it. The concrete
    // case is the confirmation frame, whose data is a live signed
    // capability: reconstructed into memory it would be re-injected into the
    // model's context and could come back out as text.
    const frames = await framesFor([
      { data: 'Confirma para continuar.' },
      { data: '{"token":"aitc1.LIVE-CAPABILITY.sig"}', event: 'some_event_added_later' },
    ])
    const text = reconstructAssistantText(frames)
    assert.equal(text, 'Confirma para continuar.')
    assert.notInclude(text, 'LIVE-CAPABILITY', 'an unrecognized event must never reach memory')
  })
})
