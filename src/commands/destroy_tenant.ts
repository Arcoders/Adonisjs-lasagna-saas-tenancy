import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TenantDeleted from '../events/tenant_deleted.js'

export default class DestroyTenant extends BaseCommand {
  static readonly commandName = 'tenant:destroy'
  static readonly description = 'Soft-delete a tenant and tear down its schema'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID to destroy' })
  declare tenantId: string

  @flags.boolean({ description: 'Skip confirmation prompt', alias: 'y', default: false })
  declare force: boolean

  @flags.boolean({
    flagName: 'keep-schema',
    default: false,
    description:
      'Soft-delete only — preserve the tenant schema for the configured retention window. Use tenant:purge-expired later.',
  })
  declare keepSchema: boolean

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    try {
      const tenant = await repo.findByIdOrFail(this.tenantId)

      if (!this.force) {
        const verb = this.keepSchema
          ? 'soft-delete (schema preserved)'
          : 'destroy (schema dropped)'
        const confirmed = await this.prompt.confirm(
          `Are you sure you want to ${verb} tenant "${tenant.name}" (${tenant.email})?`
        )
        if (!confirmed) {
          this.logger.info('Aborted.')
          return
        }
      }

      const hooks = await app.container.make(HookRegistry)
      await hooks.run('before', 'destroy', { tenant })

      const { DateTime } = await import('luxon')
      tenant.deletedAt = DateTime.now()
      await tenant.save()

      if (this.keepSchema) {
        this.logger.info(
          `Tenant "${tenant.name}" soft-deleted. Schema preserved — run tenant:purge-expired after retention window.`
        )
      } else {
        this.logger.info(`Tenant "${tenant.name}" soft-deleted. Uninstalling schema...`)
        const driver = await getActiveDriver()
        await driver.destroy(tenant)
      }

      await hooks.run('after', 'destroy', { tenant })
      await TenantDeleted.dispatch(tenant)

      this.logger.success(`Tenant "${tenant.name}" has been destroyed.`)
    } catch (error) {
      this.logger.error(`Failed to destroy tenant: ${error.message}`)
      this.exitCode = 1
    }
  }
}
