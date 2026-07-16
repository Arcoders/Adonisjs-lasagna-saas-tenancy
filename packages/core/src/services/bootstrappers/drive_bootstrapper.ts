import type { BootstrapperContext, TenantBootstrapper } from '../bootstrapper_registry.js'
import { tenancy } from '../../tenancy.js'
import { assertSafeIdentifier } from '../../isthmus/guarded_identifier.js'

/**
 * Lazily resolve `@adonisjs/drive` so the package never imports it eagerly:
 * Drive is an optional peer dependency. Apps that don't install it simply
 * skip the bootstrapper at registration time.
 */
async function lazyDrive(): Promise<{
  use(diskName?: string): {
    [key: string]: any
  }
}> {
  // The string literal is a `Function`-typed dynamic import so TypeScript
  // doesn't try to resolve the module at compile time. `@adonisjs/drive`
  // is an OPTIONAL peer dependency and is not present in this package's
  // own node_modules.
  const specifier = '@adonisjs/drive/services/main'
  const mod: any = await (Function('s', 'return import(s)') as (s: string) => Promise<any>)(
    specifier
  )
  return mod.default ?? mod
}

/**
 * The base path segment prepended to every per-tenant Drive storage key. The
 * tenant bootstrapper combines this constant with the active tenant id to form
 * the full prefix `tenants/<id>/`, which scopes each tenant's files into its own
 * folder or object-key namespace on the configured Drive backend (local disk, S3, etc).
 */
export const TENANT_DRIVE_PREFIX = 'tenants/'

/**
 * Disk methods that take a `key` (relative path) as the first argument.
 * The wrapper prepends the per-tenant prefix to that argument and forwards
 * everything else as-is. Anything not in this set is forwarded untouched,
 * so configuration getters, signed-URL options, etc. keep working.
 */
const KEYED_METHODS = new Set([
  'get',
  'getStream',
  'getArrayBuffer',
  'getMetaData',
  'getVisibility',
  'getUrl',
  'getSignedUrl',
  'put',
  'putStream',
  'setVisibility',
  'delete',
  'deleteAll',
  'copy',
  'move',
  'exists',
  'has',
  'list',
  'listAll',
])

/**
 * Build a `TenantBootstrapper` that, at scope entry, does nothing, and
 * exposes a wrapped disk via `tenantDisk()` that automatically prefixes
 * every key with `tenants/{tenant.id}/`.
 *
 * Why no real `enter` work: `@adonisjs/drive` disks are stateless on the
 * key axis (they hold a config + a backend client). Per-tenant scoping is
 * cheap enough to apply at the call site, so the bootstrapper just stakes
 * out the slot in the registry and keeps the `enter`/`leave` pattern
 * uniform with cache/mail/session.
 */
export function createDriveBootstrapper(): TenantBootstrapper {
  return {
    name: 'drive',
    enter(ctx: BootstrapperContext) {
      // Validate now so a malformed id never lands in a path component
      // (the prefix `tenants/<id>/` becomes a real folder on disk / S3
      // key prefix; an injected `..` could escape the tenant scope).
      assertSafeIdentifier(ctx.tenant.id, 'tenant id')
    },
  }
}

/**
 * The default `TenantBootstrapper` instance for `@adonisjs/drive`, produced by
 * `createDriveBootstrapper()`. Registered under the name `drive`, its `enter`
 * hook validates the active tenant id as a safe identifier so a malformed value
 * can never escape the per-tenant `tenants/{id}/` path prefix; it does no other
 * scope-entry work because Drive disks are stateless on the key axis and the
 * prefix is applied lazily by `tenantDisk()` at each call site.
 */
const driveBootstrapper = createDriveBootstrapper()
export default driveBootstrapper

/**
 * Computes the Drive storage key prefix for the tenant of the currently active
 * tenancy scope, in the form `tenants/<tenant-id>/`. It reads the active id from
 * `tenancy.currentId()`, throwing a descriptive error when called outside a
 * `tenancy.run()` scope, and validates the id with `assertSafeIdentifier` so a
 * malformed value can never escape the tenant folder via path traversal.
 *
 * @returns The per-tenant key prefix string, e.g. `tenants/<tenant-id>/`.
 * @throws If invoked without an active `tenancy.run()` scope, or if the resolved tenant id fails the safe-identifier check.
 */
export function tenantPrefix(): string {
  const id = tenancy.currentId()
  if (!id) {
    throw new Error(
      'tenantPrefix() called outside a tenancy.run() scope. Wrap your code in tenancy.run(tenant, fn) or build the prefix yourself.'
    )
  }
  assertSafeIdentifier(id, 'tenant id')
  return `${TENANT_DRIVE_PREFIX}${id}/`
}

/**
 * Resolves an optional `@adonisjs/drive` disk and returns a Proxy-wrapped handle
 * whose key-taking methods automatically prepend the active tenant's
 * `tenants/{tenant.id}/` prefix to their first path argument, transparently
 * scoping reads, writes, copies, and moves to the current tenant. It lazily
 * imports Drive as an optional peer and throws when called outside a
 * `tenancy.run()` scope, since the prefix depends on the resolved tenant id.
 *
 * @example
 *   await tenantDisk().put('avatar.png', bytes)
 *   // backend stores at: tenants/<tenant.id>/avatar.png
 *
 *   await tenantDisk('s3').get('reports/q1.csv')
 *   // backend reads from: tenants/<tenant.id>/reports/q1.csv
 *
 * The wrapper is a Proxy so we don't have to enumerate the entire Drive
 * surface; methods we list in `KEYED_METHODS` get their first argument
 * prefixed, all others forward verbatim.
 */
export async function tenantDisk(diskName?: string): Promise<any> {
  const prefix = tenantPrefix()
  const drive = await lazyDrive()
  const disk = drive.use(diskName)

  return new Proxy(disk, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      if (typeof prop !== 'string' || !KEYED_METHODS.has(prop)) {
        return value.bind(target)
      }
      return function (this: unknown, ...args: unknown[]) {
        // First arg is always the key; subsequent args (destination key,
        // options) keep their semantics. `copy` and `move` take TWO keys,
        // both belong to the tenant, so we prefix both.
        if (args.length > 0 && typeof args[0] === 'string') {
          args[0] = `${prefix}${stripLeadingSlash(args[0])}`
        }
        if (
          (prop === 'copy' || prop === 'move') &&
          args.length > 1 &&
          typeof args[1] === 'string'
        ) {
          args[1] = `${prefix}${stripLeadingSlash(args[1] as string)}`
        }
        return value.apply(target, args)
      }
    },
  })
}

function stripLeadingSlash(key: string): string {
  return key.startsWith('/') ? key.slice(1) : key
}
