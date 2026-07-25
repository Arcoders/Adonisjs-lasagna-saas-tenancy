import type { IoBroadcastOperator, IoHandshake, IoServer, IoSocket } from '../../src/types.js'

/**
 * Faithful in-memory double for the slice of the socket.io `Server`/`Socket`
 * surface `TenantSocketServer` uses. Lets the unit suite exercise handshake
 * rejection, per-event context, room isolation, and severance deterministically
 * with no network, no timers, and no socket.io install (it stays an optional
 * peer). The real socket.io types are structurally compatible with `IoServer` /
 * `IoSocket`, so what passes here is what runs in production for these methods.
 */
export class FakeSocket implements IoSocket {
  readonly rooms = new Set<string>()
  data: IoSocket['data'] = {}
  connected = true
  /** Messages the server pushed to this socket (server to client). */
  readonly received: Array<{ event: string; args: unknown[] }> = []
  readonly #listeners = new Map<string, Array<(...args: any[]) => void>>()

  constructor(
    readonly id: string,
    readonly handshake: IoHandshake
  ) {}

  join(room: string): void {
    this.rooms.add(room)
  }

  on(event: string, listener: (...args: any[]) => void): void {
    const list = this.#listeners.get(event) ?? []
    list.push(listener)
    this.#listeners.set(event, list)
  }

  disconnect(): void {
    this.connected = false
  }

  /** Test-only: simulate the client emitting `event` (client to server). */
  emitIncoming(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args)
  }

  /** Internal: the server delivered a message to this socket. */
  deliver(event: string, args: unknown[]): void {
    this.received.push({ event, args })
  }
}

export class FakeIo implements IoServer {
  readonly sockets: FakeSocket[] = []
  #handshake?: (socket: IoSocket, next: (err?: Error) => void) => void | Promise<void>
  #connection?: (socket: IoSocket) => void
  closed = false

  use(fn: (socket: IoSocket, next: (err?: Error) => void) => void | Promise<void>): void {
    this.#handshake = fn
  }

  on(event: 'connection', listener: (socket: IoSocket) => void): void {
    if (event === 'connection') this.#connection = listener
  }

  to(room: string): IoBroadcastOperator {
    return this.#operator(room)
  }

  in(room: string): IoBroadcastOperator {
    return this.#operator(room)
  }

  close(callback?: (err?: Error) => void): void {
    this.closed = true
    for (const socket of this.sockets) socket.disconnect()
    callback?.()
  }

  /** Test-only: run a socket through the handshake middleware. */
  connect(socket: FakeSocket): Promise<{ ok: boolean; code?: string; error?: Error }> {
    return new Promise((resolve) => {
      if (!this.#handshake) return resolve({ ok: true })
      this.#handshake(socket, (err) => {
        if (err) {
          const code = (err as Error & { data?: { code?: string } }).data?.code
          return resolve({ ok: false, error: err, ...(code !== undefined ? { code } : {}) })
        }
        this.sockets.push(socket)
        this.#connection?.(socket)
        resolve({ ok: true })
      })
    })
  }

  #operator(room: string): IoBroadcastOperator {
    const targets = this.sockets.filter((s) => s.rooms.has(room) && s.connected)
    return {
      emit: (event: string, ...args: unknown[]) => {
        for (const socket of targets) socket.deliver(event, args)
      },
      disconnectSockets: () => {
        for (const socket of targets) socket.disconnect()
      },
    }
  }
}

/** Resolve on the next macrotask so fire-and-forget handlers can settle. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
