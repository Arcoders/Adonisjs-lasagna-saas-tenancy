import { assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { IoHandshake, IoServer, IoSocket } from './types.js'

export const TENANT_ROOM_PREFIX = 'tenant:'

/**
 * The deterministic socket.io room a tenant's sockets all join. The id is run
 * through the same identifier guard the rest of the package uses, so a malformed
 * id can never widen the room namespace. It is defense in depth on top of the UUID
 * check the handshake reader already applies.
 */
export function tenantRoom(tenantId: string): string {
  assertSafeIdentifier(tenantId, 'tenant id')
  return `${TENANT_ROOM_PREFIX}${tenantId}`
}

interface LoggerLike {
  error(...args: unknown[]): void
  debug?(...args: unknown[]): void
}

/**
 * Everything `TenantSocketServer` needs from the outside world, injected so the
 * class carries no container/boot dependency and every branch is unit-testable
 * with plain fakes. The provider wires these from core (`tenancy`,
 * `getActiveDriver`, the tenant repository, `CircuitBreakerService`); tests pass
 * lightweight stand-ins.
 */
export interface TenantSocketServerDeps {
  /** Resolve the tenant id from a handshake (see `resolveTenantIdFromHandshake`). */
  resolveTenantId(handshake: IoHandshake): string | undefined
  /** Load the tenant model by id, or `null` if unknown. */
  loadTenant(id: string): Promise<TenantModelContract | null>
  /** Throw if the tenant must not be served (suspended/deleted/provisioning/…). */
  assertServiceable(tenant: TenantModelContract): void
  /** Open (idempotently) the tenant's DB connection so handler queries route. */
  connectTenant(tenant: TenantModelContract): Promise<void>
  /** Run `fn` inside the tenant's `tenancy.run()` scope. */
  runAsTenant<T>(tenant: TenantModelContract, fn: () => T | Promise<T>): Promise<T>
  /** The active tenant id within a bound scope, or `undefined` outside one. */
  currentTenantId(): string | undefined
  /** Optional authorization seam. A falsy return rejects the upgrade. */
  authorize?:
    | ((socket: IoSocket, tenant: TenantModelContract) => boolean | Promise<boolean>)
    | undefined
  logger?: LoggerLike
}

/**
 * Wires per-tenant isolation onto a socket.io server:
 *
 *  - a handshake middleware that resolves + validates the tenant and joins the
 *    socket to its room;
 *  - `onTenantEvent` / `bindTenant`, which re-enter the tenant context around
 *    **each** inbound event (socket.io fires handlers in later event-loop ticks,
 *    so a context set once at connect time would not reach them. This is the
 *    one rule app code must follow for DB queries inside handlers to route);
 *  - tenant-scoped emit/broadcast/disconnect helpers.
 */
export default class TenantSocketServer {
  #io?: IoServer
  readonly #deps: TenantSocketServerDeps
  readonly #connectionHandlers: Array<(socket: IoSocket) => void> = []

  constructor(deps: TenantSocketServerDeps) {
    this.#deps = deps
  }

  /**
   * Install the handshake middleware + connection dispatcher on a socket.io
   * server and remember it. The provider calls this when the HTTP server is
   * ready (on the framework `http:server_ready` event).
   */
  attach(io: IoServer): void {
    this.#io = io
    io.use((socket, next) => {
      this.#handshake(socket).then(
        () => next(),
        (err) => next(err as Error)
      )
    })
    io.on('connection', (socket) => {
      for (const handler of this.#connectionHandlers) {
        try {
          handler(socket)
        } catch (err) {
          this.#log(err, 'connection')
        }
      }
    })
  }

  /**
   * The attached socket.io Server, or `undefined` before `attach()` runs (or
   * when socket.io is not installed and WebSockets stayed disabled). Exposed so a
   * host can attach the socket.io Redis adapter for multi-node fan-out and wire
   * the cross-node severance bridge. See the "Scaling to multiple nodes" recipe
   * in the multi-tenant WebSockets cookbook.
   */
  get io(): IoServer | undefined {
    return this.#io
  }

  /**
   * Register a per-connection setup callback. This is where you wire your
   * `onTenantEvent(...)` handlers. Safe to call before `attach()` (e.g. from a
   * `start/*.ts` preload that runs before the provider attaches socket.io):
   * callbacks are dispatched to each socket as it connects.
   */
  onConnection(handler: (socket: IoSocket) => void): void {
    this.#connectionHandlers.push(handler)
  }

  async #handshake(socket: IoSocket): Promise<void> {
    const id = this.#deps.resolveTenantId(socket.handshake)
    if (!id) {
      throw handshakeError('TENANT_REQUIRED', 'No tenant id present in the WebSocket handshake')
    }

    // Backend I/O (tenant lookup, pool connect) is wrapped so a central-DB
    // outage surfaces as a generic, retryable code and never the raw driver error
    // string. This mirrors how `request.tenant()` maps such failures to a 503
    // instead of leaking a Lucid message. The real error is logged server-side.
    let tenant: TenantModelContract | null
    try {
      tenant = await this.#deps.loadTenant(id)
    } catch (err) {
      this.#log(err, 'handshake:lookup')
      throw handshakeError('TENANT_UNAVAILABLE', 'Tenant backend unavailable')
    }
    if (!tenant) {
      throw handshakeError('TENANT_NOT_FOUND', `Unknown tenant "${id}"`)
    }

    // Fail closed on lifecycle BEFORE connecting. This mirrors the HTTP guard so a
    // suspended/deleted tenant can never open a socket or a pool. These throw
    // their own deliberate codes (TENANT_SUSPENDED/…), which are safe to surface.
    this.#deps.assertServiceable(tenant)

    if (this.#deps.authorize) {
      let ok = false
      try {
        ok = await this.#deps.authorize(socket, tenant)
      } catch (err) {
        // An authorize hook that throws is treated as a denial (fail closed),
        // and its message is not forwarded to the client.
        this.#log(err, 'handshake:authorize')
        throw handshakeError('UNAUTHORIZED', 'WebSocket authorization denied')
      }
      if (!ok) throw handshakeError('UNAUTHORIZED', 'WebSocket authorization denied')
    }

    try {
      await this.#deps.connectTenant(tenant)
    } catch (err) {
      this.#log(err, 'handshake:connect')
      throw handshakeError('TENANT_UNAVAILABLE', 'Tenant backend unavailable')
    }
    socket.data.tenant = tenant
    socket.join(tenantRoom(tenant.id))
  }

  /**
   * Wrap a handler so it runs inside the socket's tenant context. The wrapper
   * re-opens the tenant connection first (idempotent; a cheap Map-lookup no-op
   * when the pool already holds it, but it re-registers a connection the LRU
   * evicted during an idle gap), then runs the handler inside `tenancy.run()`.
   * Returns the bound function so callers can await it (e.g. socket.io acks).
   *
   * Note: `tenancy.run()` enters/leaves the full tenant bootstrapper chain
   * (cache/mail/…) per event by design, so handler code can use `tenantCache()`
   * etc. For very high-frequency events this is the cost of that guarantee.
   */
  bindTenant<A extends unknown[]>(
    socket: IoSocket,
    fn: (...args: A) => unknown
  ): (...args: A) => Promise<void> {
    const tenant = socket.data.tenant
    if (!tenant) {
      throw new Error('bindTenant: socket has no resolved tenant (handshake not completed)')
    }
    return async (...args: A) => {
      await this.#deps.connectTenant(tenant)
      await this.#deps.runAsTenant(tenant, () => fn(...args))
    }
  }

  /**
   * Register an inbound event handler that runs inside the socket's tenant
   * context. **Use this (or `bindTenant`) for every handler.** A bare
   * `socket.on(...)` runs with no tenant context and its DB queries will throw.
   */
  onTenantEvent<A extends unknown[]>(
    socket: IoSocket,
    event: string,
    fn: (...args: A) => unknown
  ): void {
    const bound = this.bindTenant(socket, fn)
    socket.on(event, (...args: A) => {
      void bound(...args).catch((err) => this.#log(err, event))
    })
  }

  /** Emit to every socket of a specific tenant. */
  emitToTenant(tenantId: string, event: string, ...args: unknown[]): void {
    this.#requireIo()
      .to(tenantRoom(tenantId))
      .emit(event, ...args)
  }

  /**
   * Emit to the current tenant's room, read from the active context. Mirrors
   * `tenantBroadcast()`'s ergonomics for SSE; call it from inside a bound
   * handler. Throws if no tenant scope is active.
   */
  broadcastToTenant(event: string, ...args: unknown[]): void {
    const id = this.#deps.currentTenantId()
    if (!id) {
      throw new Error(
        'broadcastToTenant() called outside a bound socket handler. Register handlers with ' +
          'onTenantEvent()/bindTenant(), or use emitToTenant(tenantId, …) with an explicit id.'
      )
    }
    this.#requireIo()
      .to(tenantRoom(id))
      .emit(event, ...args)
  }

  /** Sever every socket of a tenant. Used on suspend and delete. */
  disconnectTenant(tenantId: string): void {
    this.#requireIo().in(tenantRoom(tenantId)).disconnectSockets(true)
  }

  /** Best-effort drain of the socket.io server. */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.#io) return resolve()
      this.#io.close((err) => (err ? reject(err) : resolve()))
    })
  }

  #requireIo(): IoServer {
    if (!this.#io) {
      throw new Error('TenantSocketServer: attach(io) has not been called yet')
    }
    return this.#io
  }

  #log(err: unknown, event: string): void {
    this.#deps.logger?.error(
      { err: (err as Error)?.message, event },
      '[websockets] tenant event handler failed'
    )
  }
}

function handshakeError(code: string, message: string): Error {
  const err = new Error(message)
  ;(err as Error & { data?: unknown }).data = { code }
  return err
}
