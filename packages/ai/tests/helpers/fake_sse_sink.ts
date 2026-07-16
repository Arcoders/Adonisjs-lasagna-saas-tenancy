import { EventEmitter } from 'node:events'

/**
 * A minimal `SseSink` double for unit-testing the SSE writer without a real
 * socket. Records every write, lets a test drive backpressure (make `write()`
 * return false so the writer awaits `'drain'`), and inherits `on`/`off`/`once`
 * plus `emit` from EventEmitter so a test can fire `'drain'` and `'error'`.
 */
export class FakeSseSink extends EventEmitter {
  readonly writes: string[] = []
  #backpressure = false

  /** When true, `write()` returns false so the writer awaits a `'drain'` event. */
  setBackpressure(on: boolean): void {
    this.#backpressure = on
  }

  write(chunk: string): boolean {
    this.writes.push(chunk)
    return !this.#backpressure
  }

  /** All writes joined, for asserting frame content. */
  get output(): string {
    return this.writes.join('')
  }
}

/** Resolve after the microtask + immediate queue drains, so a pending await settles. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
