import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { assertContractCompat } from '../sdk/contract_version.js'
import type { MiddlewareName } from '../sdk/brands.js'
import PluginMiddlewareException from '../exceptions/plugin_middleware_exception.js'

/**
 * The tenant-middleware contract version: the shape of {@link TenantMiddlewareEntry}.
 * Bump as a MAJOR for a backward-incompatible change. INDEPENDENT of `satelliteApi`,
 * the facade `pluginApiVersion`, and the published version (plan: pluggable
 * request-path surface → its own constant).
 */
export const TENANT_MIDDLEWARE_CONTRACT_VERSION = 1

/** The three route scopes a plugin middleware can attach to, mirroring the
 *  `router.tenant() / central() / universal()` helpers. */
export type TenantMiddlewareScope = 'tenant' | 'central' | 'universal'

/** A middleware handle. Either a bare `(ctx, next)` function or an object with a
 *  `handle(ctx, next)` method — both accepted by the Adonis router's `.use()`. */
export type TenantMiddlewareHandle = (ctx: HttpContext, next: NextFn) => unknown | Promise<unknown>
export type TenantMiddleware = TenantMiddlewareHandle | { handle: TenantMiddlewareHandle }

/**
 * A registered tenant middleware. Discriminated by `kind` (E1), all fields
 * `readonly`. `name` is branded (minted via `middlewareName()`), so a raw string
 * cannot reach this slot. Runs AFTER the core scope middleware (guard / central /
 * universal), so `request.tenant()` is already resolved when it executes.
 */
export interface TenantMiddlewareEntry {
  readonly kind: 'middleware'
  readonly name: MiddlewareName
  readonly middleware: TenantMiddleware
  /** Which route scope to attach to. Defaults to `tenant`. */
  readonly scope?: TenantMiddlewareScope
  /** Ascending run order within a scope; ties break by registration order. Defaults to 0. */
  readonly order?: number
  /** Contract version this middleware was built against (see {@link TENANT_MIDDLEWARE_CONTRACT_VERSION}). */
  readonly contractVersion?: number
}

/**
 * Registry of plugin-injected route middleware. Bound as a container singleton by
 * `MultitenancyProvider`; plugins register entries in their `boot()`. Map-backed
 * (stateful): resolve via `container.make`, never `new`.
 *
 * `installRouterMacros` (core `start()`, after every `boot()`) pre-resolves each
 * scope through {@link resolve} and closes over the instances, so a plugin's
 * middleware is stacked onto `router.tenant()/central()/universal()` groups AFTER
 * the core scope middleware and BEFORE the host's own `.use()` chain.
 */
export default class TenantMiddlewareRegistry {
  readonly #entries = new Map<MiddlewareName, TenantMiddlewareEntry>()

  /** The tenant-middleware contract version this surface implements. */
  get contractVersion(): number {
    return TENANT_MIDDLEWARE_CONTRACT_VERSION
  }

  register(entry: TenantMiddlewareEntry): this {
    if (this.#entries.has(entry.name)) {
      throw new PluginMiddlewareException(
        `A tenant middleware named "${entry.name}" is already registered.`,
        { plugin: entry.name }
      )
    }
    assertContractCompat(
      entry.contractVersion,
      TENANT_MIDDLEWARE_CONTRACT_VERSION,
      `tenant middleware "${entry.name}"`
    )
    this.#entries.set(entry.name, entry)
    return this
  }

  unregister(name: MiddlewareName): boolean {
    return this.#entries.delete(name)
  }

  has(name: MiddlewareName): boolean {
    return this.#entries.has(name)
  }

  list(): readonly MiddlewareName[] {
    return [...this.#entries.keys()]
  }

  /**
   * The middleware attached to a scope, ordered by ascending `order` (default 0);
   * the Map preserves registration order and Array#sort is stable, so equal
   * `order` keeps registration order. Returns an empty array for a scope no plugin
   * targeted — byte-identical to the pre-seam router behavior.
   */
  resolve(scope: TenantMiddlewareScope): readonly TenantMiddleware[] {
    return [...this.#entries.values()]
      .filter((e) => (e.scope ?? 'tenant') === scope)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((e) => e.middleware)
  }
}
