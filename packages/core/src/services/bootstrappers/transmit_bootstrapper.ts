import type { BootstrapperContext, TenantBootstrapper } from '../bootstrapper_registry.js'
import { emitIsthmusEvent } from '../../isthmus/audit.js'
import { tenancy } from '../../tenancy.js'
import { assertSafeIdentifier } from '../../isthmus/guarded_identifier.js'

/**
 * Lazy resolver for `@adonisjs/transmit`. The package never imports it
 * eagerly because Transmit is an optional peer dependency; apps that don't
 * install it simply skip this bootstrapper at registration time.
 */
async function lazyTransmit(): Promise<{
  broadcast(channel: string, payload?: any): Promise<void> | void
  broadcastExcept?: (channel: string, except: string | string[], payload?: any) => any
  [key: string]: any
}> {
  const specifier = '@adonisjs/transmit/services/main'
  const mod: any = await (Function('s', 'return import(s)') as (s: string) => Promise<any>)(
    specifier
  )
  return mod.default ?? mod
}

/**
 * The default channel-name prefix for tenant-scoped Transmit broadcasting,
 * with the literal value `tenants/`. Broadcast helpers prepend this prefix
 * together with the current tenant id to produce wire channel names of the
 * form `tenants/<tenant.id>/<channel>`, so two tenants subscribing to the
 * same logical channel never collide. It also serves as the fallback when
 * `TransmitBootstrapperOptions.prefix` is not supplied.
 */
export const TENANT_BROADCAST_PREFIX = 'tenants/'

/**
 * Configuration options accepted by `createTransmitBootstrapper()` when wiring
 * up per-tenant broadcasting on top of Transmit. The single `prefix` property
 * lets callers override the channel-name prefix used to namespace tenant
 * channels, which defaults to `tenants/`, producing wire channel names shaped
 * as `<prefix><tenant.id>/<channel>` so that different tenants subscribing to
 * the same logical channel never collide.
 */
export interface TransmitBootstrapperOptions {
  /**
   * Override the channel prefix. Default `tenants/`. Resulting channel
   * names are `<prefix><tenant.id>/<channel>`.
   */
  prefix?: string
}

let configuredPrefix = TENANT_BROADCAST_PREFIX

/**
 * Build a `TenantBootstrapper` that prepares per-tenant broadcasting.
 * Pure side-effect-free: the bootstrapper validates the tenant id at
 * scope entry (so a malformed id can't poison a channel name) but does
 * not retain any per-scope handle. Channel names are derived on demand by
 * `tenantBroadcast()`.
 */
export function createTransmitBootstrapper(
  opts: TransmitBootstrapperOptions = {}
): TenantBootstrapper {
  const prefix = opts.prefix ?? TENANT_BROADCAST_PREFIX
  configuredPrefix = prefix
  return {
    name: 'transmit',
    enter(ctx: BootstrapperContext) {
      assertSafeIdentifier(ctx.tenant.id, 'tenant id')
    },
  }
}

/**
 * The default `TenantBootstrapper` for per-tenant Transmit broadcasting, built
 * from `createTransmitBootstrapper()` with the standard `tenants/` channel
 * prefix. On scope entry it validates the tenant id with `assertSafeIdentifier`
 * so a malformed id cannot poison a channel name, and it holds no per-scope
 * state. Channel names are derived on demand by `tenantBroadcast()` and
 * `tenantChannel()` rather than retained here.
 */
const transmitBootstrapper = createTransmitBootstrapper()
export default transmitBootstrapper

function tenantPrefixForBroadcast(): string {
  const id = tenancy.currentId()
  if (!id) {
    throw new Error(
      'tenantBroadcast() called outside a tenancy.run() scope. Wrap your code in tenancy.run(tenant, fn) or call transmit.broadcast() directly with a fully-qualified channel name.'
    )
  }
  assertSafeIdentifier(id, 'tenant id')
  return `${configuredPrefix}${id}/`
}

/**
 * Broadcast a payload over a tenant-scoped channel. The channel is
 * automatically rewritten to `tenants/<tenant.id>/<channel>` so two
 * tenants subscribing to `chat` never collide.
 *
 * @example
 *   await tenantBroadcast('chat', { message: 'hi' })
 *   // wire channel: tenants/<tenant.id>/chat
 */
export async function tenantBroadcast(channel: string, payload?: unknown): Promise<void> {
  const prefix = tenantPrefixForBroadcast()
  const transmit = await lazyTransmit()
  await transmit.broadcast(`${prefix}${normalizeChannel(channel)}`, payload)
}

/**
 * The full per-tenant channel name for an unscoped channel id. Useful when
 * you need to subscribe (Transmit subscribes via the client SDK, not the
 * server) and want the canonical wire name to ship to the front end.
 */
export function tenantChannel(channel: string): string {
  return `${tenantPrefixForBroadcast()}${normalizeChannel(channel)}`
}

/**
 * Channel suffix safety: alphanumerics, dot, dash, underscore, and `/` for
 * sub-channels. Rejects `..` segments (cross-tenant escape) and absolute
 * paths. Channels are not file paths but Transmit treats `/` as a hierarchy
 * separator, so an unfiltered `..` could broadcast into a sibling tenant's
 * namespace.
 */
const CHANNEL_SAFE = /^[a-zA-Z0-9._\-/]+$/

function normalizeChannel(channel: string): string {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new Error('tenantBroadcast/tenantChannel: channel must be a non-empty string')
  }
  const stripped = channel.startsWith('/') ? channel.slice(1) : channel
  if (!CHANNEL_SAFE.test(stripped)) {
    emitIsthmusEvent('guard.broadcast_channel', {
      metadata: { channel: String(channel).slice(0, 64), reason: 'unsafe-characters' },
    })
    throw new Error(
      `Refusing unsafe broadcast channel "${channel}". Channels must match /^[a-zA-Z0-9._\\-/]+$/.`
    )
  }
  // `..` as a path segment can escape the tenant prefix in any system that
  // treats `/` hierarchically. We reject it as a whole-segment match.
  for (const segment of stripped.split('/')) {
    if (segment === '..' || segment === '.') {
      emitIsthmusEvent('guard.broadcast_channel', {
        metadata: { channel: String(channel).slice(0, 64), reason: 'dot-segment' },
      })
      throw new Error(
        `Refusing broadcast channel "${channel}" containing a "${segment}" segment ` +
          `(would escape the per-tenant namespace).`
      )
    }
  }
  return stripped
}
