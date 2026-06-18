import type { ApplicationService } from '@adonisjs/core/types'
import { HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import type { SatelliteProviderContract } from '@adonisjs-lasagna/saas-tenancy/sdk'
import ExampleWidgetService from '../src/example_widget_service.js'

/**
 * Reference satellite provider. Register it in the host's `adonisrc.ts`
 * alongside the core `MultitenancyProvider` (the configure hook does this for
 * you via `registerSatelliteInRcFile`).
 *
 * It demonstrates the platform rules:
 *  - `register()` binds the satellite's own singleton.
 *  - `start()` self-registers a tenant-lifecycle hook against the core
 *    `HookRegistry` — core never imports this package; the dependency only goes
 *    satellite → core.
 *  - core services are resolved through `app.container.make`, never `new`-ed.
 */
export default class ExampleSatelliteProvider implements SatelliteProviderContract {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(ExampleWidgetService, () => new ExampleWidgetService())
  }

  async start() {
    const hooks = await this.app.container.make(HookRegistry)
    // Clean up this satellite's rows when a tenant is hard-deleted.
    hooks.before('destroy', async (ctx) => {
      const service = await this.app.container.make(ExampleWidgetService)
      await service.deleteForTenant(ctx.tenant.id)
    })
  }
}
