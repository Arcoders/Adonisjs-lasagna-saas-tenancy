import type { HttpContext } from '@adonisjs/core/http'

/**
 * Combine several optional abort signals into one that fires when the earliest of
 * them aborts, carrying that signal's reason. Absent entries are dropped, so a
 * caller passes a heterogeneous list (an internal timeout, a caller signal, a
 * liveness signal, a disconnect signal) without pre-checking each. Zero live
 * signals give undefined (nothing to abort on); exactly one gives that signal
 * unwrapped (no needless `AbortSignal.any` layer); two or more give `AbortSignal.any`.
 *
 * This is the single `AbortSignal.any` composition point in the kernel. safeFetch
 * and executeExtension both route through it, so signal composition is defined
 * once and cannot drift between the two.
 */
export function composeSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  return AbortSignal.any(live)
}

/**
 * Bridge a client disconnect on the inbound request into an AbortSignal, so a
 * long-lived handler (a streamed response) can stop when the caller hangs up.
 *
 * This helper is the ONLY sanctioned place that touches `ctx.request.request`
 * (the raw Node `IncomingMessage`); an `@architecture` guard
 * (`inbound_request_seam.spec.ts`) enforces that, because attaching a listener to
 * the raw socket anywhere else is how a `'close'` listener leaks and how
 * disconnect handling drifts from this disposed seam.
 *
 * The `'close'` event fires on BOTH a real client hangup and the normal
 * end-of-response, so we abort only while the response has NOT finished
 * (`writableEnded === false`), which is the hangup case; a clean finish disposes
 * without aborting. Call `dispose()` in the same `finally` that settles/releases
 * so the listener is always removed.
 *
 * `writableEnded` means the handler has CALLED `res.end()` (the producer is done),
 * which is the correct boundary here: we abort the producer only while it is still
 * producing. It is deliberately not `writableFinished` (fully flushed). Once
 * `end()` is called there is nothing left to abort, so a disconnect during the
 * final flush needs no signal. A handler that streams without a pre-emptive
 * `end()` (the SSE case this seam serves) never sees that window.
 */
export function onRequestDisconnect(ctx: HttpContext): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const req = ctx.request.request
  const res = ctx.response.response
  const onClose = () => {
    // A 'close' while the response is not yet finished is a real client hangup;
    // the normal end-of-response 'close' (writableEnded === true) must not abort.
    if (!res.writableEnded) controller.abort(new Error('client_disconnect'))
  }
  req.on('close', onClose)
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener('close', onClose)
    },
  }
}
