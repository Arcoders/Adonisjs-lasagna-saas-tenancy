import { DEFAULT_EVENT, HEARTBEAT_FRAME } from './sse_constants.js'
import type { StreamFragment } from '../types/ai_provider_contract.js'

/**
 * The minimal sink the writer needs: a Node `ServerResponse` satisfies it, but
 * a plain double does too, so the writer is unit-testable without an HttpContext.
 */
export interface SseSink {
  write(chunk: string): boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface SseWriterOptions {
  /** SSE event name when a fragment does not set one. Default `'token'`. */
  defaultEvent?: string
  /**
   * Resume cursor from the client's `Last-Event-ID`. The writer continues
   * stamping monotonic ids from here, so a reconnected stream never reuses an id.
   */
  lastEventId?: string | undefined
}

/**
 * Formats and writes SSE frames to a sink, honoring backpressure (awaits
 * `'drain'` when `write()` returns false), stamping monotonic ids (continuing
 * from a resume cursor), and surfacing a broken socket as a rejected write so
 * the caller can abort rather than loop into a dead connection. Frame formatting
 * lives here and nowhere else.
 */
export default class SseWriter {
  readonly #sink: SseSink
  readonly #defaultEvent: string
  #lastId: number
  /** A sink error captured out-of-band (EPIPE, socket hang up), rethrown on the next write. */
  #sinkError: Error | undefined
  readonly #onSinkError: (err: unknown) => void

  constructor(sink: SseSink, opts: SseWriterOptions = {}) {
    this.#sink = sink
    this.#defaultEvent = opts.defaultEvent ?? DEFAULT_EVENT
    this.#lastId = parseResumeCursor(opts.lastEventId)
    this.#onSinkError = (err) => {
      this.#sinkError = toError(err)
    }
    this.#sink.on('error', this.#onSinkError as (...args: unknown[]) => void)
  }

  /** The id of the last flushed frame, or undefined if none has flushed. */
  get lastEventId(): string | undefined {
    return this.#lastId > 0 ? String(this.#lastId) : undefined
  }

  /**
   * Write one fragment as an SSE frame, stamping a monotonic id. Multi-line data
   * is split into one `data:` line per line, per the SSE spec. Resolves once the
   * frame is flushed (or drained); rejects if the socket is broken.
   */
  async writeFragment(fragment: StreamFragment): Promise<{ id: string }> {
    const id = String(++this.#lastId)
    const event = fragment.event ?? this.#defaultEvent
    await this.#writeRaw(formatFrame(id, event, fragment.data))
    return { id }
  }

  /**
   * Write an in-band `event: error` frame carrying only a classified code, never
   * an upstream body. Used post-headers, where a throw is no longer an option.
   */
  async writeErrorEvent(code: string): Promise<void> {
    await this.#writeRaw(`event: error\ndata: ${code}\n\n`)
  }

  /** Write a heartbeat comment to hold the connection open and surface a dead socket. */
  writeHeartbeat(): void {
    if (this.#sinkError) throw this.#sinkError
    this.#sink.write(HEARTBEAT_FRAME)
  }

  /** Detach the out-of-band error listener. Call once the stream is done. */
  dispose(): void {
    this.#sink.off('error', this.#onSinkError as (...args: unknown[]) => void)
  }

  async #writeRaw(frame: string): Promise<void> {
    if (this.#sinkError) throw this.#sinkError
    let ok: boolean
    try {
      ok = this.#sink.write(frame)
    } catch (err) {
      this.#sinkError = toError(err)
      throw this.#sinkError
    }
    if (!ok) await this.#awaitDrain()
  }

  /** Resolve on `'drain'`, reject on a sink `'error'`, so a broken socket stops the pump. */
  #awaitDrain(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup()
        resolve()
      }
      const onError = (err: unknown) => {
        cleanup()
        this.#sinkError = toError(err)
        reject(this.#sinkError)
      }
      const cleanup = () => {
        this.#sink.off('drain', onDrain as (...args: unknown[]) => void)
        this.#sink.off('error', onError as (...args: unknown[]) => void)
      }
      this.#sink.once('drain', onDrain as (...args: unknown[]) => void)
      this.#sink.once('error', onError as (...args: unknown[]) => void)
    })
  }
}

/** Continue ids from the resume cursor; a non-numeric or absent cursor starts at 0. */
function parseResumeCursor(lastEventId: string | undefined): number {
  if (lastEventId === undefined) return 0
  const n = Number.parseInt(lastEventId, 10)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** Format one SSE frame; multi-line data becomes one `data:` line per line. */
function formatFrame(id: string, event: string, data: string): string {
  const dataLines = data.split('\n').map((line) => `data: ${line}`)
  return `id: ${id}\nevent: ${event}\n${dataLines.join('\n')}\n\n`
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
