import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'
import type { WebSocketsConfig } from './types.js'

/**
 * The host's `config/multitenancy.ts` shape with the websockets block present.
 * Mirrors the reporting satellite's `MultitenancyConfigWithReporting` so every
 * config-bearing satellite exposes the same authoring surface (replaces the
 * provider-local `MultitenancyConfigWithWs` type).
 */
export type MultitenancyConfigWithWebsockets = MultitenancyConfig & {
  websockets?: WebSocketsConfig
}

/**
 * Identity helper for IDE autocomplete + type-checking when authoring the
 * `websockets` block of `config/multitenancy.ts`. No runtime effect.
 */
export function defineWebSocketsConfig(config: WebSocketsConfig): WebSocketsConfig {
  return config
}
