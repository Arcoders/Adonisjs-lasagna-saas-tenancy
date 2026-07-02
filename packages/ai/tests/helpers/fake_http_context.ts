import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

type Listener = (...args: unknown[]) => void

/**
 * A fake raw `IncomingMessage`: just enough of the listener API for the core
 * `onRequestDisconnect` seam (`on('close')` + `removeListener`), plus an
 * `emitClose()` lever so specs can simulate a client hangup mid-stream.
 */
export class FakeIncomingMessage {
  readonly #listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener): this {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.removeListener(event, wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener)
  }

  removeListener(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener)
    return this
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0
  }

  emitClose(): void {
    for (const listener of [...(this.#listeners.get('close') ?? [])]) {
      listener()
    }
  }
}

/**
 * A fake raw `ServerResponse`: records headers and written chunks, satisfies
 * the SseSink listener surface, and tracks `writableEnded` the way the
 * disconnect latch expects.
 */
export class FakeServerResponse {
  readonly headers: Record<string, string> = {}
  readonly chunks: string[] = []
  flushed = false
  ended = false
  writableEnded = false
  writeError: Error | undefined

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = String(value)
  }

  flushHeaders(): void {
    this.flushed = true
  }

  write(chunk: string): boolean {
    if (this.writeError) throw this.writeError
    this.chunks.push(chunk)
    return true
  }

  end(): void {
    this.ended = true
    this.writableEnded = true
  }

  on(): this {
    return this
  }

  off(): this {
    return this
  }

  once(): this {
    return this
  }

  get output(): string {
    return this.chunks.join('')
  }
}

export interface FakeHttpContextOptions {
  tenant?: TenantModelContract | null
  body?: unknown
  /** Header map, lower-cased names. */
  headers?: Record<string, string>
  /** A fake @adonisjs/auth principal, read by the default resolvePrincipal. */
  auth?: { user?: { id?: unknown } }
}

/**
 * The response facade double: `status(...).send(...)` records what a
 * pre-flight failure answered with, and `response` is the raw fake.
 */
export interface FakeResponseFacade {
  response: FakeServerResponse
  sentStatus: number | undefined
  sentBody: unknown
  status(code: number): FakeResponseFacade
  send(body: unknown): FakeResponseFacade
}

/** Build a fake HttpContext for controller unit specs. */
export function fakeHttpContext(options: FakeHttpContextOptions = {}) {
  const res = new FakeServerResponse()
  const rawRequest = new FakeIncomingMessage()

  const responseFacade: FakeResponseFacade = {
    response: res,
    sentStatus: undefined,
    sentBody: undefined,
    status(code: number) {
      this.sentStatus = code
      return this
    },
    send(body: unknown) {
      this.sentBody = body
      return this
    },
  }

  const ctx = {
    request: {
      tenant: async () => options.tenant ?? null,
      header: (name: string) => options.headers?.[name.toLowerCase()],
      body: () => options.body,
      request: rawRequest,
    },
    response: responseFacade,
    auth: options.auth,
  } as unknown as HttpContext

  return { ctx, res, rawRequest, responseFacade }
}
