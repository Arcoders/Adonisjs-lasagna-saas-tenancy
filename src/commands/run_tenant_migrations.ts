import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract, TenantModelContract } from '../types/contracts.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TenantMigrated from '../events/tenant_migrated.js'

export default class RunTenantMigrations extends BaseCommand {
  static readonly commandName = 'migration:tenant:run'
  static readonly description = 'Migrate the tenant schema'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    required: false,
    description: 'Tenant(s) id(s) to migrate. If not provided, all tenants will be migrated',
  })
  declare tenantsIds?: string[]

  @flags.boolean({ default: false, flagName: 'dry-run', description: 'View SQL without running' })
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

    for (const tenant of tenants) {
      await this.migrateTenant(tenant)
    }
  }

  private async migrateTenant(tenant: TenantModelContract) {
    const tasks = this.ui.tasks({ verbose: this.verbose })
    const hooks = await app.container.make(HookRegistry)

    const driver = await getActiveDriver()

    await tasks
      .add(`Migrating tenant "${tenant.name}": schema (${tenant.schemaName})`, async (task) => {
        try {
          task.update('Connecting to the tenant database')
          await driver.connect(tenant)

          if (!this.dryRun) {
            await hooks.run('before', 'migrate', { tenant, direction: 'up' })
          }

          task.update('Running migrations')
          await driver.migrate(tenant, {
            direction: 'up',
            disableLocks: this.disableLocks,
            dryRun: this.dryRun,
          })

          if (!this.dryRun) {
            await hooks.run('after', 'migrate', { tenant, direction: 'up' })
            await TenantMigrated.dispatch(tenant, 'up')
          }

          return 'completed'
        } catch (error) {
          return this.verbose ? task.error(error.message) : task.error('failed')
        }
      })
      .run()
  }
}
