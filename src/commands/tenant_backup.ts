import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import BackupService from '../services/backup_service.js'

export default class TenantBackup extends BaseCommand {
  static readonly commandName = 'tenant:backup'
  static readonly description = 'Backup one or all active tenants synchronously'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({ alias: 't', flagName: 'tenant', description: 'Tenant ID(s) to back up' })
  declare tenant?: string[]

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const service = new BackupService()

    const allActive = await repo.all({ statuses: ['active'] })
    const tenants = this.tenant?.length
      ? allActive.filter((t) => this.tenant!.includes(t.id))
      : allActive

    if (tenants.length === 0) {
      this.logger.info('No active tenants found.')
      return
    }

    let succeeded = 0
    let failed = 0

    for (const tenant of tenants) {
      const tasks = this.ui.tasks()

      await tasks
        .add(`Backing up "${tenant.name}" (${tenant.schemaName})`, async (task) => {
          try {
            const meta = await service.backup(tenant)
            task.update(`Saved to ${meta.file} (${(meta.size / 1024 / 1024).toFixed(2)} MB)`)
            succeeded++
            return 'completed'
          } catch (error) {
            failed++
            return task.error(error.message)
          }
        })
        .run()
    }

    this.logger.info(`Done: ${succeeded} succeeded, ${failed} failed`)
  }
}
