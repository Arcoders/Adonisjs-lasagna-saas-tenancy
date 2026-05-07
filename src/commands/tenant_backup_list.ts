import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import BackupService from '../services/backup_service.js'

export default class TenantBackupList extends BaseCommand {
  static readonly commandName = 'tenant:backup:list'
  static readonly description = 'List available backups for one or all tenants'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({ alias: 't', flagName: 'tenant', description: 'Filter by tenant ID' })
  declare tenantId?: string

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const service = new BackupService()

    const tenants = this.tenantId
      ? [await repo.findByIdOrFail(this.tenantId)]
      : await repo.all()

    if (tenants.length === 0) {
      this.logger.info('No tenants found.')
      return
    }

    const table = this.ui.table()
    table.head(['Tenant ID', 'Tenant Name', 'File', 'Size (MB)', 'Timestamp'])

    let total = 0

    for (const tenant of tenants) {
      const backups = await service.listBackups(tenant.id)
      for (const b of backups) {
        table.row([tenant.id, tenant.name, b.file, (b.size / 1024 / 1024).toFixed(2), b.timestamp])
        total++
      }
    }

    if (total === 0) {
      this.logger.info('No backups found.')
      return
    }

    table.render()
    this.logger.info(`Total: ${total} backup(s)`)
  }
}
