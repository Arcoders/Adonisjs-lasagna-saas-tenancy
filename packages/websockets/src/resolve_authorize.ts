import { assertContractCompat } from '@adonisjs-lasagna/saas-tenancy/sdk'
import { WEBSOCKETS_CONTRACT_VERSION } from './constants.js'
import type { WebSocketsConfig, WebSocketAuthorizeFn } from './types.js'

/**
 * Normalize the configured `authorize` (bare function or versioned object) to a
 * plain {@link WebSocketAuthorizeFn} the socket server can call. The object form
 * opts into the contract-version check here, at wiring time: a version newer
 * than this build throws (the authorizer relies on a surface this build doesn't
 * provide); an older or absent version warns and proceeds. A bare function is
 * the documented simple form and is passed through unversioned.
 */
export function normalizeAuthorize(
  value: WebSocketsConfig['authorize']
): WebSocketAuthorizeFn | undefined {
  if (!value) return undefined
  if (typeof value === 'function') return value
  assertContractCompat(value.contractVersion, WEBSOCKETS_CONTRACT_VERSION, 'websockets authorizer')
  return value.authorize
}
