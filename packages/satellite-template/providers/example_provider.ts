import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'
import { HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import ExampleWidgetService from '../src/example_widget_service.js'

/**
 * Reference satellite provider, built with the {@link definePlugin} facade — the
 * blessed way to author a Lasagna satellite. Register it in the host's
 * `adonisrc.ts` alongside the core `MultitenancyProvider` (the configure hook does
 * this for you via `registerSatelliteInRcFile`).
 *
 * It demonstrates the platform rules:
 *  - the facade wires the ABI backstops (Satellite ABI + facade contract) for you,
 *    so you declare `satelliteApi` / `pluginApiVersion` once and the boot-time
 *    assertions run inside the facade.
 *  - `bind` binds the satellite's own singleton (this is `register()`).
 *  - `start` self-registers a tenant-lifecycle hook against the core
 *    `HookRegistry` — core never imports this package; the dependency only goes
 *    satellite → core.
 *  - core services are resolved through `app.container.make`, never `new`-ed.
 *
 * A satellite that needs a request-path seam adds one of the declarative sections
 * (`authorizers` / `middleware` / `requestMacros` / `provides`); this template
 * needs none. Authors who want the raw provider lifecycle instead of the facade
 * can still `implements SatelliteProviderContract` directly — `definePlugin` is
 * sugar over exactly that contract.
 */
export default definePlugin({
  name: 'example-widgets',
  packageName: '@adonisjs-lasagna/satellite-template',
  // Mirrors package.json#lasagnaSatellite.satelliteApi.
  satelliteApi: 1,
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  bind(app) {
    app.container.singleton(ExampleWidgetService, () => new ExampleWidgetService())
  },

  async start(app) {
    const hooks = await app.container.make(HookRegistry)
    // Clean up this satellite's rows when a tenant is hard-deleted.
    hooks.before('destroy', async (ctx) => {
      const service = await app.container.make(ExampleWidgetService)
      await service.deleteForTenant(ctx.tenant.id)
    })
  },
})
