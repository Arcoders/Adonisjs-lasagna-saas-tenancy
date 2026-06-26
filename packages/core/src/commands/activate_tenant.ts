import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import { auditCliAction } from './audit_cli_action.js'
import TenantActivated from '../events/tenant_activated.js'

export default class ActivateTenant extends BaseCommand {
  static readonly commandName = 'tenant:activate'
  static readonly description = 'Activate a suspended or failed tenant'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID to activate' })
  declare tenantId: string

  @flags.string({ description: 'Acting admin id recorded in the audit log (default: system)' })
  declare admin?: string

  async run() {
    const repo = await resolveTenantRepository()

    try {
      const tenant = await repo.findByIdOrFail(this.tenantId)

      if (tenant.isActive) {
        this.logger.warning(`Tenant "${tenant.name}" is already active.`)
        return
      }

      await tenant.activate()
      await TenantActivated.dispatch(tenant)
      await auditCliAction(this.logger, {
        tenantId: tenant.id,
        action: 'admin:tenant:activate',
        adminId: this.admin,
        metadata: { status: tenant.status },
      })
      this.logger.success(`Tenant "${tenant.name}" has been activated.`)
    } catch (error) {
      this.logger.error(`Failed to activate tenant: ${error.message}`)
      this.exitCode = 1
    }
  }
}
