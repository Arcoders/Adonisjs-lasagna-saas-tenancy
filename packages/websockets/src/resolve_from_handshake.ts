import { isUuidV4 } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type { IoHandshake, WebSocketHandshakeConfig } from './types.js'

const DEFAULT_AUTH_KEY = 'tenantId'
const DEFAULT_HEADER_KEY = 'x-tenant-id'

/**
 * Map a socket.io handshake to a validated tenant id. Pure and side-effect free
 * so it is trivially unit-testable. Tries the configured sources in a fixed
 * precedence (`auth`, then `header`, then `query`, then `subdomain`) and returns the first
 * candidate that is a valid UUID v4. Anything malformed yields `undefined`, so
 * the handshake middleware rejects the upgrade rather than opening a connection
 * against a garbage id.
 *
 * The core resolver registry is intentionally NOT reused here: its resolvers
 * read an AdonisJS `HttpRequest`, whereas a WS handshake only exposes raw
 * `auth` / `headers` / `query`.
 */
export function resolveTenantIdFromHandshake(
  handshake: IoHandshake,
  config: WebSocketHandshakeConfig = {}
): string | undefined {
  const candidate = readCandidate(handshake, config)
  return candidate && isUuidV4(candidate) ? candidate : undefined
}

function readCandidate(
  handshake: IoHandshake,
  config: WebSocketHandshakeConfig
): string | undefined {
  const authKey = config.authKey ?? DEFAULT_AUTH_KEY
  if (authKey !== false) {
    const value = asString(handshake.auth?.[authKey])
    if (value) return value
  }

  const headerKey = config.headerKey ?? DEFAULT_HEADER_KEY
  if (headerKey !== false) {
    const value = asString(handshake.headers?.[headerKey.toLowerCase()])
    if (value) return value
  }

  if (config.queryKey) {
    const value = asString(handshake.query?.[config.queryKey])
    if (value) return value
  }

  if (config.subdomain && config.baseDomain) {
    const value = subdomainOf(asString(handshake.headers?.['host']), config.baseDomain)
    if (value) return value
  }

  return undefined
}

/**
 * Coerce a header/query value (string, string[], or undefined) to a single
 * trimmed string. Node lowercases header names, so callers look up lowercased
 * keys; values keep their original case.
 */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return asString(value[0])
  }
  return undefined
}

function subdomainOf(host: string | undefined, baseDomain: string): string | undefined {
  if (!host) return undefined
  const bare = host.split(':')[0]
  const suffix = baseDomain.startsWith('.') ? baseDomain : `.${baseDomain}`
  if (!bare.endsWith(suffix)) return undefined
  const sub = bare.slice(0, bare.length - suffix.length)
  return sub.length > 0 ? sub : undefined
}
