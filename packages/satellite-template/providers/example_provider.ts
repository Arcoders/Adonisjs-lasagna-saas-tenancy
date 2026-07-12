import {
  definePlugin,
  LASAGNA_PLUGIN_API_VERSION,
  permission,
  authorizer,
  middleware,
  requestMacro,
  defineCapability,
  schedule,
} from '@adonisjs-lasagna/saas-tenancy/plugin'
import { HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import ExampleWidgetService from '../src/example_widget_service.js'

// Lazy logger: importing `@adonisjs/core/services/logger` at module top-level
// top-level-awaits `app.booted(...)` and throws outside an Ignitor, which would
// make this provider un-importable in a unit test. Import it inside the handler,
// where the app is always booted.
const lazyLogger = () => import('@adonisjs/core/services/logger').then((m) => m.default)

/**
 * Reference satellite provider, built with the {@link definePlugin} facade (the
 * blessed way to author a Lasagna satellite). Register it in the host's
 * `adonisrc.ts` alongside the core `MultitenancyProvider` (the configure hook does
 * this for you via `registerSatelliteInRcFile`).
 *
 * This is the CANONICAL MIRROR: it exercises every declarative seam the platform
 * ships, so a satellite author can copy the one they need and delete the rest. A
 * real satellite would wire only the seams it uses. None of these examples is
 * mandatory, and the template stays dependency-free (each handler is a no-op /
 * logs) so it compiles and boots against a fresh consumer in CI.
 *
 * The facade wires the ABI backstops (Satellite ABI + plugin-API contract) for you,
 * so you declare `satelliteApi` / `pluginApiVersion` once and the boot-time
 * assertions run inside the facade. Core services are resolved through
 * `app.container.make`, never `new`-ed; the dependency only ever goes from
 * satellite to core. Authors who want the raw provider lifecycle instead of the
 * facade can still `implements SatelliteProviderContract` directly. `definePlugin`
 * is sugar over exactly that contract.
 */
export default definePlugin({
  name: 'example-widgets',
  packageName: '@adonisjs-lasagna/satellite-template',
  // Mirrors package.json#lasagnaSatellite.satelliteApi.
  satelliteApi: 1,
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  // Declared, sensitive capabilities shown to the operator at install for consent
  // (S1). Kept coherent with package.json#lasagnaSatellite.permissions by the
  // check-plugin-permissions guard. Declaration is DISCLOSURE, not enforcement:
  // this satellite registers a schedule (the scheduler permission) and subscribes
  // to writes on the ExampleWidget model (the data_change permission).
  permissions: [permission.scheduler(), permission.dataChange('ExampleWidget')],

  // register(): bind the satellite's own singleton.
  bind(app) {
    app.container.singleton(ExampleWidgetService, () => new ExampleWidgetService())
  },

  // start(): self-register a tenant-lifecycle hook against the core HookRegistry.
  // Core never imports this package; the dependency only goes from satellite to core.
  async start(app) {
    const hooks = await app.container.make(HookRegistry)
    // Clean up this satellite's rows when a tenant is hard-deleted.
    hooks.before('destroy', async (ctx) => {
      const service = await app.container.make(ExampleWidgetService)
      await service.deleteForTenant(ctx.tenant.id)
    })
  },

  // --- Request-path seams (Lote A) ---

  // SEAM-3: a fail-closed tenant-access authorizer, appended to the chain. A real
  // one checks membership / a claim; this reference always allows.
  authorizers: () => [
    authorizer({
      name: 'example-widgets-access',
      authorize: () => ({ allow: true }),
    }),
  ],

  // SEAM-2: route middleware stacked onto the tenant scope (runs after core's
  // guard/central/universal middleware, so `request.tenant()` is resolved). A
  // pass-through reference.
  middleware: () => [
    middleware({
      name: 'example-widgets-touch',
      scope: 'tenant',
      middleware: (_ctx, next) => next(),
    }),
  ],

  // SEAM-4: a `request.<name>()` macro mirrored on the request. The reference
  // returns a static marker; a real one would resolve per-request state.
  requestMacros: () => [
    requestMacro({
      name: 'exampleWidgets',
      resolve: () => ({ enabled: true }),
    }),
  ],

  // Capability provided for optional cross-plugin composition. Another plugin can
  // `consume('example-widgets')` and degrade gracefully when it is absent.
  provides: () => [
    defineCapability({
      name: 'example-widgets',
      api: { describe: () => 'the example-widgets reference capability' },
    }),
  ],

  // --- Worker seams (Lote B) ---

  // SEAM-1: a periodic tick that fans out over active tenants, dispatching the
  // per-tenant `example_widgets_sweep` BullMQ job to each. A real satellite defines
  // that job (a TenantJob); the tick only enqueues.
  schedules: () => [
    schedule({
      name: 'example-widgets-sweep',
      job: 'example_widgets_sweep',
      everyMs: 60 * 60 * 1000,
      deliveryGuarantee: 'reconciling',
    }),
  ],

  // SEAM-7: a Postgres extension installed into each tenant's storage at provision
  // time. Identifiers are validated at boot, so a typo fails the deploy, not the
  // first provision. `pg_trgm` is a common, dependency-free example.
  provisionExtensions: () => [{ name: 'pg_trgm' }],

  // --- Event seam (Lote C) ---

  // SEAM-5: react to committed writes on the ExampleWidget model, decoupled from
  // the write (after-commit, fail-open), so this never blocks or breaks a tenant's
  // write. A search or analytics satellite would REINDEX or count here; the
  // reference just logs.
  onDataChange: () => [
    {
      models: ['ExampleWidget'],
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
