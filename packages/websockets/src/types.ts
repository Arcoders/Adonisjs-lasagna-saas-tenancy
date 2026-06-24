import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Minimal structural slice of the socket.io `Server`/`Socket` surface this
 * package actually touches. Declaring it here (instead of importing from
 * `socket.io`) keeps socket.io a true *optional* peer: the satellite builds,
 * typechecks, and unit-tests with nothing installed, and the provider
 * lazy-imports the real implementation at runtime, the same pattern core uses
 * for the optional `@adonisjs/transmit` peer. The real socket.io types are
 * structurally compatible with these for the methods we use.
 */
export interface IoHandshake {
  /** socket.io `auth` payload, e.g. `io(url, { auth: { tenantId } })`. */
  auth?: Record<string, unknown>
  headers: Record<string, unknown>
  query: Record<string, unknown>
}

export interface IoSocket {
  readonly id: string
  readonly handshake: IoHandshake
  /** Per-connection bag. We stash the resolved tenant on `data.tenant`. */
  data: Record<string, unknown> & { tenant?: TenantModelContract }
  join(room: string): unknown
  on(event: string, listener: (...args: any[]) => void): unknown
  disconnect(close?: boolean): unknown
}

export interface IoBroadcastOperator {
  emit(event: string, ...args: unknown[]): unknown
  disconnectSockets(close?: boolean): unknown
}

export interface IoServer {
  use(fn: (socket: IoSocket, next: (err?: Error) => void) => void | Promise<void>): unknown
  on(event: 'connection', listener: (socket: IoSocket) => void): unknown
  to(room: string): IoBroadcastOperator
  in(room: string): IoBroadcastOperator
  close(callback?: (err?: Error) => void): unknown
}

/**
 * Where in the WebSocket handshake the tenant id is read from. The reader tries
 * the configured sources in this fixed precedence and stops at the first hit:
 * `auth`, then `header`, then `query`, then `subdomain`. Set a key to `false` to disable
 * that source.
 */
export interface WebSocketHandshakeConfig {
  /**
   * Key inside `handshake.auth`. Default `'tenantId'`. The recommended source
   * for browsers, which cannot set custom headers on the WS upgrade. Set to
   * `false` to disable.
   */
  authKey?: string | false
  /**
   * Header name. Default the core `tenantHeaderKey` (`x-tenant-id`). Good for
   * server-to-server clients. Set to `false` to disable.
   */
  headerKey?: string | false
  /**
   * Query-string parameter. Default `false` (disabled, since query strings leak into
   * logs). Set to a key like `'tenant_id'` to enable.
   */
  queryKey?: string | false
  /**
   * Derive the tenant id from the leftmost label of the `Host` header
   * (`acme.app.com` gives `acme`). Default `false`. Requires {@link baseDomain}.
   */
  subdomain?: boolean
  /** Base domain to strip for `subdomain` resolution, e.g. `app.com`. */
  baseDomain?: string
}

/**
 * Authorization seam. Resolving a client-supplied tenant id is NOT
 * authentication: implement this to verify the connecting principal actually
 * belongs to `tenant`. Returning a falsy value (or throwing) rejects the upgrade.
 */
export type WebSocketAuthorizeFn = (
  socket: IoSocket,
  tenant: TenantModelContract
) => boolean | Promise<boolean>

/**
 * The versioned form of {@link WebSocketAuthorizeFn}. Supply this instead of a
 * bare function to opt into the contract-version check at wiring time (see
 * `WEBSOCKETS_CONTRACT_VERSION`): a version newer than this build throws, older
 * or absent warns.
 */
export interface WebSocketAuthorizer {
  readonly contractVersion?: number
  authorize: WebSocketAuthorizeFn
}

export interface WebSocketsConfig {
  /** socket.io mount path. Default socket.io's own default (`/socket.io`). */
  path?: string
  /**
   * Passed straight through to socket.io's `ServerOptions.cors`. Browsers on a
   * tenant subdomain are a cross-origin request to the apex API, so this is
   * usually required in production.
   */
  cors?: unknown
  /** Where to read the tenant id from the handshake. */
  handshake?: WebSocketHandshakeConfig
  /**
   * Authorization seam, as a bare {@link WebSocketAuthorizeFn} (simple,
   * unversioned) or a {@link WebSocketAuthorizer} object that declares the
   * contract version it was built against. Returning a falsy value rejects the
   * upgrade.
   */
  authorize?: WebSocketAuthorizeFn | WebSocketAuthorizer
}
