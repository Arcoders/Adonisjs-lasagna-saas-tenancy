import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import TenantSuspended from '../events/tenant_suspended.js'

export default class SuspendTenant extends BaseCommand {
  static readonly commandName = 'tenant:suspend'
  static readonly description = 'Suspend a tenant (blocks all API access)'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID to suspend' })
  declare tenantId: string

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    try {
      const tenant = await repo.findByIdOrFail(this.tenantId)

      if (tenant.isSuspended) {
        this.logger.warning(`Tenant "${tenant.name}" is already suspended.`)
        return
      }

      await tenant.suspend()
      await TenantSuspended.dispatch(tenant)
      this.logger.success(`Tenant "${tenant.name}" has been suspended.`)
    } catch (error) {
      this.logger.error(`Failed to suspend tenant: ${error.message}`)
      this.exitCode = 1
    }
  }
}
