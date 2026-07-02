import type { SseSink } from './sse_writer.js'
import type { StreamTarget } from './stream_extension.js'
import { HEARTBEAT_FRAME } from './sse_constants.js'

export interface RecordingStreamTarget {
  /** The tee'd target to hand the streaming service; writes pass through untouched. */
  readonly target: StreamTarget
  /** The recorded SSE frames, in write order (heartbeats excluded). Empty after an overflow. */
  frames(): string[]
  /** True once the recorded bytes passed the cap; recording stops, streaming does not. */
  readonly overflowed: boolean
}

/**
 * Tee a {@link StreamTarget} so every SSE frame the service writes is also
 * captured for the idempotency cache, without touching the stream itself:
 * writes pass through synchronously with the inner sink's own backpressure
 * verdict, heartbeats are filtered by their frozen frame constant, and
 * passing the byte cap simply stops recording (and frees what was captured;
 * an overflowed response is uncacheable anyway). O(frames) appends; nothing
 * here can abort or delay the stream.
 */
export default function recordingStreamTarget(
  inner: StreamTarget,
  options: { maxBytes: number }
): RecordingStreamTarget {
  const frames: string[] = []
  let bytes = 0
  let overflowed = false

  const sink: SseSink = {
    write(chunk: string): boolean {
      if (!overflowed && typeof chunk === 'string' && chunk !== HEARTBEAT_FRAME) {
        bytes += Buffer.byteLength(chunk, 'utf8')
        if (bytes > options.maxBytes) {
          overflowed = true
          frames.length = 0
        } else {
          frames.push(chunk)
        }
      }
      return inner.sink.write(chunk)
    },
    on: (event, listener) => inner.sink.on(event, listener),
    off: (event, listener) => inner.sink.off(event, listener),
    once: (event, listener) => inner.sink.once(event, listener),
  }

  return {
    target: {
      sink,
      flushHeaders: () => inner.flushHeaders(),
      disconnect: () => inner.disconnect(),
    },
    frames: () => [...frames],
    get overflowed() {
      return overflowed
    },
  }
}
