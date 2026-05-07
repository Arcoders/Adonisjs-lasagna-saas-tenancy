import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import BackupService from '../services/backup_service.js'

export default class TenantRestore extends BaseCommand {
  static readonly commandName = 'tenant:restore'
  static readonly description = 'Restore a tenant schema from a backup file'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({ alias: 't', flagName: 'tenant', description: 'Tenant ID', required: true })
  declare tenantId: string

  @flags.string({ flagName: 'file', description: 'Backup file name', required: true })
  declare file: string

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const service = new BackupService()

    const tenant = await repo.findByIdOrFail(this.tenantId)

    const confirmed = await this.prompt.confirm(
      `Restore tenant "${tenant.name}" from "${this.file}"? This will overwrite current data.`
    )

    if (!confirmed) {
      this.logger.info('Restore cancelled.')
      return
    }

    const tasks = this.ui.tasks()

    await tasks
      .add(`Restoring "${tenant.name}" from ${this.file}`, async (task) => {
        try {
          task.update('Running pg_restore...')
          await service.restore(tenant, this.file)
          return 'completed'
        } catch (error) {
          return task.error(error.message)
        }
      })
      .run()

    this.logger.success(`Tenant "${tenant.name}" restored from "${this.file}"`)
  }
}
