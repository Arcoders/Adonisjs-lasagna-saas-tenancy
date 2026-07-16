import TenantLogContext from '../../services/tenant_log_context.js'
import BootstrapperRegistry from '../../services/bootstrapper_registry.js'
import { primeTenancy } from '../../tenancy.js'
import cacheBootstrapper from '../../services/bootstrappers/cache_bootstrapper.js'
import driveBootstrapper from '../../services/bootstrappers/drive_bootstrapper.js'
import mailBootstrapper from '../../services/bootstrappers/mail_bootstrapper.js'
import sessionBootstrapper from '../../services/bootstrappers/session_bootstrapper.js'
import transmitBootstrapper from '../../services/bootstrappers/transmit_bootstrapper.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * Auto-register the bootstrappers whose peer dependencies are wired into the host
 * app. We probe `container.hasBinding(...)` instead of importing the service
 * module directly, because the service-main files in `@adonisjs/mail` etc. eagerly
 * `container.make()` the binding, which throws if the host hasn't loaded the
 * provider that registers it. Detection via the binding name is both cheaper and
 * exact: the bootstrapper is only useful when the host app actually configured the
 * underlying service.
 */
function registerOptionalBootstrappers(
  ctx: InstallerContext,
  bootstrappers: BootstrapperRegistry
): void {
  const candidates = [
    { name: 'drive', binding: 'drive.manager', bootstrapper: driveBootstrapper },
    { name: 'mail', binding: 'mail.manager', bootstrapper: mailBootstrapper },
    { name: 'session', binding: 'session', bootstrapper: sessionBootstrapper },
    { name: 'transmit', binding: 'transmit', bootstrapper: transmitBootstrapper },
  ] as const

  for (const c of candidates) {
    if (bootstrappers.has(c.name)) continue
    if (ctx.app.container.hasBinding(c.binding)) {
      bootstrappers.register(c.bootstrapper)
    } else {
      ctx.warnWhenBooted((logger) =>
        logger.debug(
          { bootstrapper: c.name, binding: c.binding },
          'multitenancy: peer service not bound; skipping bootstrapper'
        )
      )
    }
  }
}

/**
 * Tenant context plane: the tenant log context primed into `tenancy` and the
 * bootstrapper registry that reprovisions per-tenant runtime services. Grouped
 * because both are coupled through `tenancy.run()` and share a module-cache reset
 * in shutdown (`resetModuleCaches` drops both `tenancy.ts` refs).
 */
export const tenancyContextWiring: ProviderInstaller = {
  name: 'tenancy-context',

  register(ctx: InstallerContext): void {
    ctx.app.container.singleton(TenantLogContext, () => new TenantLogContext())
    ctx.app.container.singleton(BootstrapperRegistry, () => new BootstrapperRegistry())
  },

  async boot(ctx: InstallerContext): Promise<void> {
    // Seed the tenant log context into `tenancy` so `tenancy.currentId()` reflects
    // the HTTP guard's context immediately (instead of depending on whether a queue
    // job ran first). This is what lets the adapter route a model query with the
    // same id that `request.tenant()` resolved, including domain-based resolvers.
    const logCtx = await ctx.app.container.make(TenantLogContext)
    primeTenancy(logCtx)

    const bootstrappers = await ctx.app.container.make(BootstrapperRegistry)
    if (!bootstrappers.has('cache')) bootstrappers.register(cacheBootstrapper)
    registerOptionalBootstrappers(ctx, bootstrappers)
  },
}
