export {
  default as TenantSocketServer,
  tenantRoom,
  TENANT_ROOM_PREFIX,
} from './tenant_socket_server.js'
export type { TenantSocketServerDeps } from './tenant_socket_server.js'
export { resolveTenantIdFromHandshake } from './resolve_from_handshake.js'
export { normalizeAuthorize } from './resolve_authorize.js'
export { WEBSOCKETS_CONTRACT_VERSION } from './constants.js'
// Config authoring surface (mirrors the reporting satellite).
export { defineWebSocketsConfig } from './define_config.js'
export type { MultitenancyConfigWithWebsockets } from './define_config.js'
export type {
  WebSocketsConfig,
  WebSocketHandshakeConfig,
  WebSocketAuthorizeFn,
  WebSocketAuthorizer,
  IoServer,
  IoSocket,
  IoHandshake,
  IoBroadcastOperator,
} from './types.js'
