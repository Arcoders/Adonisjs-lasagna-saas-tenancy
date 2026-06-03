import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import TenantQueueService from '../services/tenant_queue_service.js'

export default class TenantQueueStats extends BaseCommand {
  static readonly commandName = 'tenant:queue:stats'
  static readonly description = 'Show BullMQ queue statistics for one or all tenant queues'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({ alias: 't', flagName: 'tenant', description: 'Filter by tenant ID(s)' })
  declare tenant?: string[]

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const service = new TenantQueueService()

    const allTenants = await repo.all({ statuses: ['active', 'suspended'] })
    const tenants = this.tenant?.length
      ? allTenants.filter((t) => this.tenant!.includes(t.id))
      : allTenants

    if (tenants.length === 0) {
      this.logger.info('No tenants found.')
      return
    }

    const stats = await Promise.all(tenants.map((t) => service.getStats(t.id)))

    const table = this.ui.table()
    table.head(['Tenant ID', 'Queue Name', 'Waiting', 'Active', 'Completed', 'Failed', 'Delayed'])

    for (const stat of stats) {
      table.row([
        stat.tenantId,
        stat.queueName,
        String(stat.waiting),
        String(stat.active),
        String(stat.completed),
        stat.failed > 0 ? this.colors.red(String(stat.failed)) : String(stat.failed),
        String(stat.delayed),
      ])
    }

    table.render()
  }
}
