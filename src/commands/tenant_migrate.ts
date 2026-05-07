import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TenantMigrated from '../events/tenant_migrated.js'

export default class TenantMigrate extends BaseCommand {
  static readonly commandName = 'tenant:migrate'
  static readonly description =
    'Run migrations for one or all tenant schemas (alias for migration:tenant:run)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    required: false,
    description: 'Tenant ID(s) to migrate. If omitted, migrates all tenants',
  })
  declare tenantsIds?: string[]

  @flags.boolean({ default: false, flagName: 'dry-run', description: 'Print SQL without executing' })
  declare dryRun: boolean

  @flags.boolean({ default: false, flagName: 'disable-locks', description: 'Disable migration locks' })
  declare disableLocks: boolean

  @flags.boolean({ default: false, flagName: 'verbose' })
  declare verbose: boolean

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenants =
      this.tenantsIds && this.tenantsIds.length > 0
        ? await repo.whereIn(this.tenantsIds, true)
        : await repo.all({ includeDeleted: true })

    if (tenants.length === 0) {
      this.logger.info('No tenants found.')
      return
    }

    const hooks = await app.container.make(HookRegistry)
    const driver = await getActiveDriver()
    let succeeded = 0
    let failed = 0

    for (const tenant of tenants) {
      const tasks = this.ui.tasks({ verbose: this.verbose })

      await tasks
        .add(`Migrating "${tenant.name}" (${tenant.schemaName})`, async (task) => {
          try {
            task.update('Connecting...')
            await driver.connect(tenant)

            if (!this.dryRun) {
              await hooks.run('before', 'migrate', { tenant, direction: 'up' })
            }

            task.update('Running migrations...')
            await driver.migrate(tenant, {
              direction: 'up',
              disableLocks: this.disableLocks,
              dryRun: this.dryRun,
            })

            if (!this.dryRun) {
              await hooks.run('after', 'migrate', { tenant, direction: 'up' })
              await TenantMigrated.dispatch(tenant, 'up')
            }

            succeeded++
            return 'completed'
          } catch (error) {
            failed++
            return this.verbose ? task.error(error.message) : task.error('failed')
          }
        })
        .run()
    }

    this.logger.info(`Done: ${succeeded} succeeded, ${failed} failed`)
  }
}
