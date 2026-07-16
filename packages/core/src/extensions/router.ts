import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ApplicationService } from '@adonisjs/core/types'
import type { Router, RouteGroup } from '@adonisjs/http-server'
import type { MiddlewareFn } from '@adonisjs/http-server/types'
import TenantGuardMiddleware from '../middleware/tenant_guard_middleware.js'
import CentralOnlyMiddleware from '../middleware/central_only_middleware.js'
import UniversalMiddleware from '../middleware/universal_middleware.js'
import TenantMiddlewareRegistry, {
  type TenantMiddleware,
} from '../services/tenant_middleware_registry.js'

/**
 * Callback handed to `router.tenant() / router.central() / router.universal()`.
 * Routes are declared via the global `router` import just as in any
 * `start/routes.ts`.
 */
export type RouteScopeCallback = () => void

declare module '@adonisjs/http-server' {
  interface Router {
    /**
     * Group routes that REQUIRE a resolved tenant. Wraps the group in
     * `TenantGuardMiddleware`, which throws if the tenant cannot be resolved
     * or is suspended/deleted/not-ready.
     */
    tenant(callback: RouteScopeCallback): RouteGroup
    /**
     * Group routes that REQUIRE the absence of a resolved tenant. Wraps the
     * group in `CentralOnlyMiddleware`. Use for signup, marketing pages,
     * back-office UIs that should not be reachable from a tenant subdomain.
     */
    central(callback: RouteScopeCallback): RouteGroup
    /**
     * Group routes that work in BOTH contexts. Wraps the group in
     * `UniversalMiddleware`, which resolves the tenant when present but
     * never fails if absent. Use for shared login pages, status endpoints,
     * marketing pages that adapt per tenant when possible.
     */
    universal(callback: RouteScopeCallback): RouteGroup
  }
}

let installed = false

interface RouterLike {
  group(callback: RouteScopeCallback): RouteGroup
  tenant?: (cb: RouteScopeCallback) => RouteGroup
  central?: (cb: RouteScopeCallback) => RouteGroup
  universal?: (cb: RouteScopeCallback) => RouteGroup
}

/**
 * Adapt a middleware into the plain-function form the route executor calls
 * with `(ctx, next)`.
 *
 * Route middleware run in exactly two shapes (http-server's
 * `src/router/executor.ts`): a plain function is invoked as `fn(ctx, next)`,
 * and anything else is treated as a ParsedNamedMiddleware whose `handle`
 * receives the CONTAINER RESOLVER first (`handle(resolver, ctx, next, args)`).
 * A bare instance whose `handle(ctx, next)` reaches `.use()` raw therefore
 * runs with the resolver where it expects the HttpContext and 500s on every
 * request; the compiler never objected because the old call site cast the
 * array to `any`. Wrapping into a function is the one shape that preserves
 * the `(ctx, next)` contract for both the core scope middleware and plugin
 * middleware (which the registry accepts as a function or `{ handle }`).
 *
 * The wrapper takes the wrapped middleware's name so route debug traces
 * ("executing middleware %s") and route inspection name the real middleware
 * instead of an anonymous closure.
 */
export function toRouteMiddleware(middleware: TenantMiddleware): MiddlewareFn {
  const handle = typeof middleware === 'function' ? middleware : middleware.handle.bind(middleware)
  const adapted: MiddlewareFn = (ctx, next) => handle(ctx, next)
  Object.defineProperty(adapted, 'name', {
    value: middlewareDisplayName(middleware),
    configurable: true,
  })
  return adapted
}

function middlewareDisplayName(middleware: TenantMiddleware): string {
  if (typeof middleware === 'function') return middleware.name || 'tenantScopedMiddleware'
  const ctor = middleware.constructor?.name
  return ctor && ctor !== 'Object' ? ctor : 'tenantScopedMiddleware'
}

/**
 * Install the `tenant() / central() / universal()` route helpers on the
 * Adonis Router singleton. Idempotent: calling more than once is a no-op.
 *
 * The helpers are thin wrappers around `router.group()` that pre-attach the
 * appropriate middleware, each adapted through {@link toRouteMiddleware} into
 * the plain-function shape the route executor invokes as `fn(ctx, next)`.
 * They return the underlying RouteGroup so callers can chain `.prefix()`,
 * `.use()`, `.where()`, etc.
 *
 * Plugin middleware registered in a satellite's `boot()` is stacked onto
 * each scope group AFTER the core scope middleware (so `request.tenant()` is
 * already resolved when it runs) and BEFORE the host's own `.use()` chain. The
 * registry is pre-resolved ONCE here (start() runs after every boot(), so it is
 * complete) and the closures capture the ordered instances per scope.
 *
 * @param routerInstance - Override for the router (test seam). Defaults to
 *   the global `@adonisjs/core/services/router` singleton, which requires
 *   the Adonis app to be booted.
 * @param middlewareRegistry - Override for the plugin middleware registry (test
 *   seam). Defaults to the container singleton; if unavailable, no plugin
 *   middleware is stacked (byte-identical to the pre-seam behavior).
 */
export async function installRouterMacros(
  routerInstance?: RouterLike,
  middlewareRegistry?: TenantMiddlewareRegistry
): Promise<void> {
  if (installed) return
  installed = true

  const r =
    routerInstance ??
    ((await import('@adonisjs/core/services/router')).default as unknown as RouterLike)

  const registry = middlewareRegistry ?? (await resolveMiddlewareRegistry())
  // Everything a macro stacks goes through toRouteMiddleware, so the executor
  // only ever sees plain `(ctx, next)` functions. No cast: MiddlewareFn[] is
  // what `RouteGroup.use()` actually accepts, and keeping the call typed is
  // what stops a raw instance from ever reaching the router again.
  const tenantMw = (registry?.resolve('tenant') ?? []).map(toRouteMiddleware)
  const centralMw = (registry?.resolve('central') ?? []).map(toRouteMiddleware)
  const universalMw = (registry?.resolve('universal') ?? []).map(toRouteMiddleware)

  const tenantGuard = toRouteMiddleware(new TenantGuardMiddleware())
  const centralOnly = toRouteMiddleware(new CentralOnlyMiddleware())
  const universal = toRouteMiddleware(new UniversalMiddleware())

  if (typeof r.tenant !== 'function') {
    r.tenant = function (callback: RouteScopeCallback) {
      return r.group(callback).use([tenantGuard, ...tenantMw])
    }
  }

  if (typeof r.central !== 'function') {
    r.central = function (callback: RouteScopeCallback) {
      return r.group(callback).use([centralOnly, ...centralMw])
    }
  }

  if (typeof r.universal !== 'function') {
    r.universal = function (callback: RouteScopeCallback) {
      return r.group(callback).use([universal, ...universalMw])
    }
  }
}

/**
 * Best-effort resolve of the plugin middleware registry from the container.
 * Returns undefined if the app is not booted / the binding is missing, so the
 * router macros still install (with no plugin middleware). The app import is lazy
 * because this runs at start() (booted), never at module load.
 */
async function resolveMiddlewareRegistry(): Promise<TenantMiddlewareRegistry | undefined> {
  try {
    const app = (await import('@adonisjs/core/services/app')).default
    return await app.container.make(TenantMiddlewareRegistry)
  } catch {
    return undefined
  }
}

export function __resetRouterMacrosForTests(routerInstance?: RouterLike): void {
  installed = false
  if (!routerInstance) return
  const r = routerInstance as any
  delete r.tenant
  delete r.central
  delete r.universal
}

/**
 * Auto-load the optional `start/tenant.ts` and `start/universal.ts` route
 * files if they exist in the host app. Called from the provider's `start()`
 * after the router macros are installed. Failures importing the files are
 * thrown. Silent failure here would leave the user wondering why their
 * tenant routes don't fire.
 */
export async function autoLoadScopedRouteFiles(
  app: ApplicationService,
  opts?: {
    tenantRoutesFile?: string
    universalRoutesFile?: string
  }
): Promise<void> {
  const tenantFile = opts?.tenantRoutesFile ?? 'tenant.ts'
  const universalFile = opts?.universalRoutesFile ?? 'universal.ts'

  for (const candidate of [tenantFile, universalFile]) {
    const tsPath = app.startPath(candidate)
    const jsPath = tsPath.replace(/\.ts$/, '.js')
    const target = existsSync(tsPath) ? tsPath : existsSync(jsPath) ? jsPath : null
    if (target) {
      await import(pathToFileURL(target).href)
    }
  }
}
