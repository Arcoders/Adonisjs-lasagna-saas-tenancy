import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'
import { HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import ExampleWidgetService from '../src/example_widget_service.js'

// Lazy logger: importing `@adonisjs/core/services/logger` at module top-level
// top-level-awaits `app.booted(...)` and throws outside an Ignitor, which would
// make this provider un-importable in a unit test. Import it inside the handler,
// where the app is always booted.
const lazyLogger = () => import('@adonisjs/core/services/logger').then((m) => m.default)

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
 * It also demonstrates a worker/event seam: `onDataChange` (SEAM-5). A search or
 * analytics satellite would REINDEX or count on each committed write; here it just
 * logs, to keep the template dependency-free while proving the facade wires the
 * seam. A satellite that needs a request-path seam adds one of the declarative
 * sections (`authorizers` / `middleware` / `requestMacros` / `provides`); one that
 * needs a periodic tick adds `schedules`. Authors who want the raw provider
 * lifecycle instead of the facade can still `implements SatelliteProviderContract`
 * directly — `definePlugin` is sugar over exactly that contract.
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

  // React to committed tenant-model writes (SEAM-5). Runs decoupled from the write
  // (after-commit, fail-open), so this never blocks or breaks a tenant's write.
  onDataChange: () => [
    {
      handle: async (change) => {
        const logger = await lazyLogger()
        logger.debug(
          { tenant: change.tenantId, model: change.model, op: change.operation },
          'example-widgets observed a tenant data change'
        )
      },
    },
  ],
})
