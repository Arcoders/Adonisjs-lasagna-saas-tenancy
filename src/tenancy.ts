import app from '@adonisjs/core/services/app'
import BootstrapperRegistry, {
  type BootstrapperContext,
} from './services/bootstrapper_registry.js'
import TenantLogContext from './services/tenant_log_context.js'
import { TENANT_REPOSITORY } from './types/contracts.js'
import type {
  TenantMetadata,
  TenantModelContract,
  TenantRepositoryContract,
} from './types/contracts.js'

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

async function run<T>(
  tenant: TenantModelContract,
  fn: () => T | Promise<T>
): Promise<T> {
  const logCtx = await getLogCtx()
  const registry = await getRegistry()
  const ctx: BootstrapperContext = { tenant }

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
async function current<TMeta extends object = TenantMetadata>(): Promise<
  TenantModelContract<TMeta> | null
> {
  const id = currentId()
  if (!id) return null
  const repo = (await app.container.make(
    TENANT_REPOSITORY as any
  )) as TenantRepositoryContract<TMeta>
  return repo.findById(id, true)
}

export const tenancy = {
  run,
  currentId,
  current,
}
