import type {
  BootstrapperContext,
  TenantBootstrapper,
} from '../bootstrapper_registry.js'
import { tenancy } from '../../tenancy.js'
import { assertSafeIdentifier } from '../isolation/identifier.js'

export const TENANT_SESSION_PREFIX = 'tenants/'

/**
 * Build a `TenantBootstrapper` that:
 *
 *   1. Validates the active tenant id at scope entry (it lands inside
 *      session keys — a malformed id can collide / poison other tenants'
 *      slots).
 *   2. Exposes a `tenantSessionKey(key)` helper that namespaces session
 *      writes — useful when one logged-in user can switch between
 *      tenants on the same domain and we want each tenant's session
 *      data to be addressable independently.
 *
 * The bootstrapper does NOT replace `@adonisjs/session`'s cookie or
 * stop the underlying session from being shared at the HTTP-cookie
 * level. That decision belongs in the host app's middleware and is
 * outside the scope of this package.
 */
export function createSessionBootstrapper(): TenantBootstrapper {
  return {
    name: 'session',
    enter(ctx: BootstrapperContext) {
      assertSafeIdentifier(ctx.tenant.id, 'tenant id')
    },
  }
}

const sessionBootstrapper = createSessionBootstrapper()
export default sessionBootstrapper

/**
 * Build a per-tenant session key. Throws outside a `tenancy.run()` scope.
 *
 * @example
 *   ctx.session.put(tenantSessionKey('cart'), cartItems)
 *   ctx.session.get(tenantSessionKey('cart'))
 *
 * Produces keys like `tenants/<tenant.id>/cart`. Tenant-A's writes never
 * collide with Tenant-B's even when both share the same user session.
 */
export function tenantSessionKey(key: string): string {
  const id = tenancy.currentId()
  if (!id) {
    throw new Error(
      'tenantSessionKey() called outside a tenancy.run() scope. Wrap the call site in tenancy.run(tenant, fn).'
    )
  }
  assertSafeIdentifier(id, 'tenant id')
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('tenantSessionKey: key must be a non-empty string')
  }
  return `${TENANT_SESSION_PREFIX}${id}/${stripLeadingSlash(key)}`
}

/**
 * Convenience: when called from an HTTP context, returns a thin wrapper
 * over `ctx.session` that auto-namespaces every key. Methods that don't
 * take a key (`commit`, `regenerate`, `flush`, …) forward verbatim.
 *
 * The `ctx` parameter is loosely typed as `unknown` so this file does
 * not depend on `@adonisjs/session`'s type augmentation of HttpContext —
 * session is an optional peer dependency.
 */
export function tenantSession(ctx: unknown): {
  get<T = unknown>(key: string, defaultValue?: T): T
  put(key: string, value: unknown): void
  forget(key: string): void
  has(key: string): boolean
  pull<T = unknown>(key: string, defaultValue?: T): T
  /** Forwarded directly to the underlying session. */
  raw: any
} {
  const session: any = (ctx as any)?.session
  if (!session) {
    throw new Error(
      'tenantSession(ctx): ctx.session is not initialized. Is @adonisjs/session installed and the session middleware registered?'
    )
  }

  return {
    get(key, defaultValue) {
      return session.get(tenantSessionKey(key), defaultValue)
    },
    put(key, value) {
      session.put(tenantSessionKey(key), value)
    },
    forget(key) {
      session.forget(tenantSessionKey(key))
    },
    has(key) {
      return session.has(tenantSessionKey(key))
    },
    pull(key, defaultValue) {
      return session.pull(tenantSessionKey(key), defaultValue)
    },
    raw: session,
  }
}

function stripLeadingSlash(key: string): string {
  return key.startsWith('/') ? key.slice(1) : key
}
