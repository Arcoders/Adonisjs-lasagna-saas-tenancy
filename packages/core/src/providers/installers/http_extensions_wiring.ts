import type { MultitenancyConfig } from '../../types/config.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * The HTTP surface, installed in `start()` so it runs after every provider's
 * boot() (plugin middleware registrations are final when installRouterMacros
 * pre-resolves each scope). Runs last in the installer array: its only work is
 * the start-phase macro install + route autoload, and it consumes the resolution
 * and plugin state the earlier installers wired. The extension modules are pulled
 * with a lazy `await import()` so this installer stays app.booted-safe.
 */
export const httpExtensionsWiring: ProviderInstaller = {
  name: 'http-extensions',

  async start(ctx: InstallerContext): Promise<void> {
    const { app } = ctx
    await import('../../extensions/request.js')

    const { installRouterMacros, autoLoadScopedRouteFiles } =
      await import('../../extensions/router.js')
    await installRouterMacros()

    const config = app.config.get<MultitenancyConfig>('multitenancy')
    if (config.routing?.autoLoad !== false) {
      await autoLoadScopedRouteFiles(app, {
        ...(config.routing?.tenantRoutesFile !== undefined
          ? { tenantRoutesFile: config.routing.tenantRoutesFile }
          : {}),
        ...(config.routing?.universalRoutesFile !== undefined
          ? { universalRoutesFile: config.routing.universalRoutesFile }
          : {}),
      })
    }
  },
}
