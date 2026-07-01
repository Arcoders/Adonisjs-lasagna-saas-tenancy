import { test } from '@japa/runner'
import SseWriter from '../../../../src/gateway/sse_writer.js'
import { FakeSseSink, tick } from '../../../helpers/fake_sse_sink.js'

test.group('SseWriter: framing + ids', () => {
  test('writes a well-formed frame with a monotonic id and the default event', async ({
    assert,
  }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    const first = await writer.writeFragment({ data: 'he', tokens: 1 })
    const second = await writer.writeFragment({ data: 'llo', tokens: 2 })
    assert.equal(first.id, '1')
    assert.equal(second.id, '2')
    assert.equal(sink.output, 'id: 1\nevent: token\ndata: he\n\nid: 2\nevent: token\ndata: llo\n\n')
    assert.equal(writer.lastEventId, '2')
  })

  test('honors a custom event name', async ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    await writer.writeFragment({ data: 'x', tokens: 1, event: 'done' })
    assert.match(sink.output, /event: done/)
  })

  test('splits multi-line data into one data: line per line', async ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    await writer.writeFragment({ data: 'line1\nline2', tokens: 1 })
    assert.equal(sink.output, 'id: 1\nevent: token\ndata: line1\ndata: line2\n\n')
  })

  test('continues ids from the Last-Event-ID resume cursor', async ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink, { lastEventId: '5' })
    const resumed = await writer.writeFragment({ data: 'x', tokens: 1 })
    assert.equal(resumed.id, '6')
  })

  test('a non-numeric resume cursor starts ids at 1', async ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink, { lastEventId: 'garbage' })
    const first = await writer.writeFragment({ data: 'x', tokens: 1 })
    assert.equal(first.id, '1')
  })
})

test.group('SseWriter: backpressure', () => {
  test('awaits drain before resolving when write() returns false', async ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    sink.setBackpressure(true)

    let resolved = false
    const pending = writer.writeFragment({ data: 'x', tokens: 1 }).then(() => {
      resolved = true
    })

    await tick()
    assert.isFalse(resolved, 'must not resolve until drain')

    sink.setBackpressure(false)
    sink.emit('drain')
    await pending
    assert.isTrue(resolved)
  })
})

test.group('SseWriter: heartbeat + error frame', () => {
  test('writeHeartbeat writes an SSE comment frame', ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    writer.writeHeartbeat()
    assert.equal(sink.output, ':\n\n')
  })

  test('writeErrorEvent emits a code-only error frame (no upstream body)', async ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    await writer.writeErrorEvent('provider_unavailable')
    assert.equal(sink.output, 'event: error\ndata: provider_unavailable\n\n')
  })
})

test.group('SseWriter: socket errors', () => {
  test('a sink error captured out-of-band rejects the next write', async ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    sink.emit('error', new Error('EPIPE'))
    await assert.rejects(() => writer.writeFragment({ data: 'x', tokens: 1 }), 'EPIPE')
    assert.throws(() => writer.writeHeartbeat(), 'EPIPE')
  })

  test('an error during drain rejects the pending write', async ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    sink.setBackpressure(true)
    const pending = writer.writeFragment({ data: 'x', tokens: 1 })
    sink.emit('error', new Error('socket hang up'))
    await assert.rejects(() => pending, 'socket hang up')
  })

  test('dispose detaches the error listener', ({ assert }) => {
    const sink = new FakeSseSink()
    const writer = new SseWriter(sink)
    assert.equal(sink.listenerCount('error'), 1)
    writer.dispose()
    assert.equal(sink.listenerCount('error'), 0)
  })
})
