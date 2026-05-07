import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ApplicationService } from '@adonisjs/core/types'
import type { Router, RouteGroup } from '@adonisjs/http-server'
import TenantGuardMiddleware from '../middleware/tenant_guard_middleware.js'
import CentralOnlyMiddleware from '../middleware/central_only_middleware.js'
import UniversalMiddleware from '../middleware/universal_middleware.js'

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
 * Install the `tenant() / central() / universal()` route helpers on the
 * Adonis Router singleton. Idempotent — calling more than once is a no-op.
 *
 * The helpers are thin wrappers around `router.group()` that pre-attach the
 * appropriate middleware. They return the underlying RouteGroup so callers
 * can chain `.prefix()`, `.use()`, `.where()`, etc.
 *
 * @param routerInstance - Override for the router (test seam). Defaults to
 *   the global `@adonisjs/core/services/router` singleton, which requires
 *   the Adonis app to be booted.
 */
export async function installRouterMacros(routerInstance?: RouterLike): Promise<void> {
  if (installed) return
  installed = true

  const r =
    routerInstance ??
    ((await import('@adonisjs/core/services/router')).default as unknown as RouterLike)

  if (typeof r.tenant !== 'function') {
    r.tenant = function (callback: RouteScopeCallback) {
      return r.group(callback).use([new TenantGuardMiddleware()] as any)
    }
  }

  if (typeof r.central !== 'function') {
    r.central = function (callback: RouteScopeCallback) {
      return r.group(callback).use([new CentralOnlyMiddleware()] as any)
    }
  }

  if (typeof r.universal !== 'function') {
    r.universal = function (callback: RouteScopeCallback) {
      return r.group(callback).use([new UniversalMiddleware()] as any)
    }
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
 * thrown — silent failure here would leave the user wondering why their
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
