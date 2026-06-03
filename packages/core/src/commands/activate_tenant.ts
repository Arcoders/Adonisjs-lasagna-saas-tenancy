import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import TenantActivated from '../events/tenant_activated.js'

export default class ActivateTenant extends BaseCommand {
  static readonly commandName = 'tenant:activate'
  static readonly description = 'Activate a suspended or failed tenant'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID to activate' })
  declare tenantId: string

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    try {
      const tenant = await repo.findByIdOrFail(this.tenantId)

      if (tenant.isActive) {
        this.logger.warning(`Tenant "${tenant.name}" is already active.`)
        return
      }

      await tenant.activate()
      await TenantActivated.dispatch(tenant)
      this.logger.success(`Tenant "${tenant.name}" has been activated.`)
    } catch (error) {
      this.logger.error(`Failed to activate tenant: ${error.message}`)
      this.exitCode = 1
    }
  }
}
