import type { WebSocketsConfig } from './types.js'

/**
 * Eager, pure validation of the `websockets` config block so a bad shape fails
 * at boot (in `WebSocketsProvider.boot`) rather than at the first socket upgrade.
 *
 * Both validated fields are optional, so `undefined` passes; only a
 * present-but-wrong type throws. Kept off the package's public barrel
 * (`src/index.ts`) on purpose — it is an internal seam imported by the provider,
 * not part of the published surface.
 */
export function assertWebSocketsConfig(config: WebSocketsConfig): void {
  if (config.path !== undefined && typeof config.path !== 'string') {
    throw new Error('[websockets] config.websockets.path must be a string')
  }
  if (config.authorize !== undefined && typeof config.authorize !== 'function') {
    throw new Error('[websockets] config.websockets.authorize must be a function')
  }
}
