import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import TenantEnteredMaintenance from '../events/tenant_entered_maintenance.js'
import TenantExitedMaintenance from '../events/tenant_exited_maintenance.js'

export default class TenantMaintenance extends BaseCommand {
  static readonly commandName = 'tenant:maintenance'
  static readonly description =
    'Toggle maintenance mode for a tenant (independent of suspended status)'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID to toggle' })
  declare tenantId: string

  @flags.boolean({
    description: 'Exit maintenance mode (default: enter)',
  })
  declare off: boolean

  @flags.string({
    description: 'Optional message shown in the 503 response while in maintenance',
  })
  declare message: string

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    try {
      const tenant = await repo.findByIdOrFail(this.tenantId)

      if (this.off) {
        if (!tenant.isMaintenance) {
          this.logger.warning(`Tenant "${tenant.name}" is not in maintenance mode.`)
          return
        }
        if (typeof tenant.exitMaintenance !== 'function') {
          this.logger.error(
            'Tenant model does not implement exitMaintenance(); add the column and methods.'
          )
          this.exitCode = 1
          return
        }
        await tenant.exitMaintenance()
        await TenantExitedMaintenance.dispatch(tenant)
        this.logger.success(`Tenant "${tenant.name}" exited maintenance mode.`)
        return
      }

      if (tenant.isMaintenance) {
        this.logger.warning(`Tenant "${tenant.name}" is already in maintenance mode.`)
        return
      }
      if (typeof tenant.enterMaintenance !== 'function') {
        this.logger.error(
          'Tenant model does not implement enterMaintenance(); add the column and methods.'
        )
        this.exitCode = 1
        return
      }
      await tenant.enterMaintenance(this.message ?? null)
      await TenantEnteredMaintenance.dispatch(tenant, this.message ?? null)
      this.logger.success(`Tenant "${tenant.name}" entered maintenance mode.`)
    } catch (error) {
      this.logger.error(`Failed to toggle maintenance: ${error.message}`)
      this.exitCode = 1
    }
  }
}
