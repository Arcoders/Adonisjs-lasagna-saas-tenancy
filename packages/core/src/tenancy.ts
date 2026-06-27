import app from '@adonisjs/core/services/app'
import BootstrapperRegistry, { type BootstrapperContext } from './services/bootstrapper_registry.js'
import TenantLogContext from './services/tenant_log_context.js'
import { getActiveDriver } from './services/isolation/active_driver.js'
import { resolveTenantRepository } from './services/resolve_tenant_repository.js'
import type { TenantMetadata, TenantModelContract } from './types/contracts.js'

/**
 * Canonical entry point for activating a tenant context outside HTTP — queue
 * jobs, scripts, scheduled tasks, custom commands, tests. Inside `fn`:
 *
 *   - `AsyncLocalStorage` is bound to the tenant via `TenantLogContext`, so
 *     `tenantLogger` and any code reading `TenantLogContext.current()` will
 *     see the bindings.
 *   - All registered `TenantBootstrapper`s have their `enter()` invoked in
 *     registration order; on exit, `leave()` is invoked in reverse order
 *     (errors logged, never rethrown).
 *
 * If any `enter()` throws, the partial `enter` chain is unwound by
 * `BootstrapperRegistry.runScoped` and the original error propagates.
 *
 * @example
 *   await tenancy.run(tenant, async () => {
 *     const posts = await Post.all()
 *     // ...
 *   })
 */
let cachedLogCtx: TenantLogContext | undefined
let cachedRegistry: BootstrapperRegistry | undefined

async function getLogCtx(): Promise<TenantLogContext> {
  if (!cachedLogCtx) cachedLogCtx = await app.container.make(TenantLogContext)
  return cachedLogCtx
}

async function getRegistry(): Promise<BootstrapperRegistry> {
  if (!cachedRegistry) cachedRegistry = await app.container.make(BootstrapperRegistry)
  return cachedRegistry
}

/**
 * Ensure the active isolation driver has registered this tenant's connection
 * before any model query routes to it. `TenantAdapter` asserts the connection
 * exists and fails closed otherwise, so this is the convenience that makes the
 * background path work without the caller remembering to connect.
 *
 * If no isolation driver is registered yet (an unbooted unit-test context),
 * skip silently: the adapter remains the hard guarantee. A driver that IS
 * registered but whose `connect()` fails (a real backend outage) propagates.
 */
async function ensureConnected(tenant: TenantModelContract): Promise<void> {
  let driver
  try {
    driver = await getActiveDriver()
  } catch {
    return
  }
  await driver.connect(tenant)
}

async function run<T>(tenant: TenantModelContract, fn: () => T | Promise<T>): Promise<T> {
  const logCtx = await getLogCtx()
  const registry = await getRegistry()
  await ensureConnected(tenant)
  const ctx: BootstrapperContext = { tenant }

  return logCtx.run({ tenantId: tenant.id }, () => registry.runScoped(ctx, fn))
}

/**
 * HTTP-path analogue of {@link run}. The request already connected the tenant
 * (request.tenant() / the universal middleware call driver.connect()), so this
 * only binds the log context AND runs the bootstrapper enter/leave lifecycle,
 * which the bare `logCtx.run()` the middlewares used before did NOT do. Used by
 * `TenantGuardMiddleware` and `UniversalMiddleware` so a host's custom
 * bootstrapper fires on HTTP requests, not only inside queue jobs. The atomic
 * enter/leave guarantee of `runScoped` ensures `leave()` always pairs a
 * successful `enter()` even when the downstream handler throws.
 */
async function runForRequest<T>(
  tenant: TenantModelContract,
  request: BootstrapperContext['request'],
  fn: () => T | Promise<T>
): Promise<T> {
  const logCtx = await getLogCtx()
  const registry = await getRegistry()
  const ctx: BootstrapperContext = { tenant, request }

  return logCtx.run({ tenantId: tenant.id }, () => registry.runScoped(ctx, fn))
}

/**
 * The currently active tenant id within a `tenancy.run()` scope, or
 * `undefined` outside of one. Synchronous; only returns a value once
 * `tenancy.run()` has been called at least once (so the singleton is cached).
 */
function currentId(): string | undefined {
  return cachedLogCtx?.currentTenantId()
}

/**
 * Seed the cached `TenantLogContext` singleton so `currentId()` reflects the
 * live AsyncLocalStorage the HTTP guard writes to, without waiting for the
 * first `tenancy.run()`. The provider calls this at boot whenever the unified
 * resolution path is active (i.e. `config.resolver.legacyAdapterFallback` is
 * not explicitly `true`, the 1.0 default), which fixes the case where the
 * adapter's id source depended on whether a queue job had run earlier in the
 * process.
 */
export function primeTenancy(logCtx: TenantLogContext): void {
  cachedLogCtx = logCtx
}

/**
 * Test-only: inject specific singletons or clear the cache. Not exported
 * from the public package surface (used by unit tests to avoid booting the
 * full Adonis app).
 */
export function __configureTenancyForTests(
  overrides: {
    logCtx?: TenantLogContext
    registry?: BootstrapperRegistry
  } = {}
): void {
  cachedLogCtx = overrides.logCtx
  cachedRegistry = overrides.registry
}

/**
 * Resolve the active tenant model from the repository if a `tenancy.run()`
 * scope is active. Returns `null` outside a scope or if the tenant cannot
 * be found.
 */
async function current<
  TMeta extends object = TenantMetadata,
>(): Promise<TenantModelContract<TMeta> | null> {
  const id = currentId()
  if (!id) return null
  const repo = await resolveTenantRepository<TMeta>()
  return repo.findById(id, true)
}

export const tenancy = {
  run,
  runForRequest,
  currentId,
  current,
}
