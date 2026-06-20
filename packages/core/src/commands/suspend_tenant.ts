import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import TenantSuspended from '../events/tenant_suspended.js'

export default class SuspendTenant extends BaseCommand {
  static readonly commandName = 'tenant:suspend'
  static readonly description = 'Suspend a tenant (blocks all API access)'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID to suspend' })
  declare tenantId: string

  async run() {
    const repo = await resolveTenantRepository()

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
