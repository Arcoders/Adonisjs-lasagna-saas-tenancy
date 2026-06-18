import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import ExampleWidgetService from '../example_widget_service.js'

/**
 * `node ace example:widget:list <tenantId>` — a minimal satellite command. The
 * shape (decorated args/flags, `startApp: true`, resolving the service from the
 * container) mirrors the core `tenant:*` commands.
 */
export default class ExampleWidgetList extends BaseCommand {
  static commandName = 'example:widget:list'
  static description = "List a tenant's example widgets (satellite template demo)"
  static options = { startApp: true } as const

  @args.string({ description: 'Tenant id' })
  declare tenantId: string

  @flags.boolean({ description: 'Emit JSON instead of a table' })
  declare json: boolean

  async run() {
    const service = await this.app.container.make(ExampleWidgetService)
    const widgets = await service.listForTenant(this.tenantId)

    if (this.json) {
      this.logger.log(JSON.stringify(widgets, null, 2))
      return
    }
    if (widgets.length === 0) {
      this.logger.info(`no widgets for tenant ${this.tenantId}`)
      return
    }
    for (const w of widgets) {
      this.logger.log(`${w.id}  ${w.name}  ${w.enabled ? 'enabled' : 'disabled'}`)
    }
  }
}
