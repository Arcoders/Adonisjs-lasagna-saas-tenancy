import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'

export default class ListTenants extends BaseCommand {
  static readonly commandName = 'tenant:list'
  static readonly description = 'List all tenants with their current status'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Include soft-deleted tenants', default: false })
  declare all: boolean

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenants = await repo.all({ includeDeleted: this.all })

    if (tenants.length === 0) {
      this.logger.info('No tenants found.')
      return
    }

    const table = this.ui.table()
    table.head(['ID', 'Name', 'Email', 'Status', 'Created At', 'Deleted'])

    for (const tenant of tenants) {
      const statusColor =
        tenant.status === 'active'
          ? 'green'
          : tenant.status === 'suspended'
            ? 'yellow'
            : tenant.status === 'failed'
              ? 'red'
              : 'cyan'

      table.row([
        tenant.id,
        tenant.name,
        tenant.email,
        this.colors[statusColor](tenant.status),
        tenant.createdAt.toFormat('yyyy-MM-dd HH:mm'),
        tenant.deletedAt ? this.colors.red('yes') : 'no',
      ])
    }

    table.render()
    this.logger.info(`Total: ${tenants.length} tenant(s)`)
  }
}
