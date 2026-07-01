import { test } from '@japa/runner'
import { EventEmitter } from 'node:events'
import { composeSignals, onRequestDisconnect } from '../../../../src/utils/signals.js'

/**
 * SEAM-4 core: `composeSignals` is the kernel's single `AbortSignal.any`
 * composition point (reused by safeFetch and executeExtension), and
 * `onRequestDisconnect` is the sanctioned bridge from a raw inbound client
 * hangup to an AbortSignal. Both are cancellation primitives, so they live under
 * the resilience guarantee.
 */

test.group('composeSignals', () => {
  test('returns undefined when there is nothing to abort on', ({ assert }) => {
    assert.isUndefined(composeSignals([]))
    assert.isUndefined(composeSignals([undefined, undefined]))
  })

  test('passes a single live signal through unwrapped (no needless layer)', ({ assert }) => {
    const c = new AbortController()
    const out = composeSignals([undefined, c.signal, undefined])
    assert.strictEqual(out, c.signal)
  })

  test('aborts when ANY composed signal aborts, carrying its reason', ({ assert }) => {
    const a = new AbortController()
    const b = new AbortController()
    const out = composeSignals([a.signal, b.signal])
    assert.instanceOf(out, AbortSignal)
    assert.notStrictEqual(out, a.signal, 'two-plus yields a distinct combined signal')
    assert.notStrictEqual(out, b.signal)
    assert.isFalse(out!.aborted)
    b.abort(new Error('second-wins'))
    assert.isTrue(out!.aborted)
    assert.match(String((out!.reason as Error).message), /second-wins/)
  })

  test('a signal already aborted before composition composes as aborted', ({ assert }) => {
    const a = new AbortController()
    const b = new AbortController()
    a.abort(new Error('pre-aborted'))
    const out = composeSignals([a.signal, b.signal])
    assert.isTrue(out!.aborted)
  })
})

test.group('onRequestDisconnect', () => {
  function fakeCtx() {
    const req = new EventEmitter()
    const res = { writableEnded: false }
    // Only the shape onRequestDisconnect reads: ctx.request.request (raw
    // IncomingMessage) and ctx.response.response (raw ServerResponse).
    const ctx = { request: { request: req }, response: { response: res } } as never
    return { ctx, req, res }
  }

  test('aborts (client_disconnect) when the socket closes mid-response', ({ assert }) => {
    const { ctx, req, res } = fakeCtx()
    const { signal } = onRequestDisconnect(ctx)
    assert.isFalse(signal.aborted)
    res.writableEnded = false // response still streaming
    req.emit('close')
    assert.isTrue(signal.aborted)
    assert.match(String((signal.reason as Error).message), /client_disconnect/)
  })

  test('does NOT abort on the normal end-of-response close', ({ assert }) => {
    const { ctx, req, res } = fakeCtx()
    const { signal } = onRequestDisconnect(ctx)
    res.writableEnded = true // response finished cleanly, then 'close' fires
    req.emit('close')
    assert.isFalse(signal.aborted)
  })

  test('dispose() removes the listener so a later close cannot abort or leak', ({ assert }) => {
    const { ctx, req, res } = fakeCtx()
    const { signal, dispose } = onRequestDisconnect(ctx)
    assert.equal(req.listenerCount('close'), 1)
    dispose()
    assert.equal(req.listenerCount('close'), 0, 'no leaked close listener')
    res.writableEnded = false
    req.emit('close')
    assert.isFalse(signal.aborted, 'a post-dispose close must not abort')
  })
})
