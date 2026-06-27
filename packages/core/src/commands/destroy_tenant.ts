import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import { auditCliAction } from './audit_cli_action.js'
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

  @flags.string({ description: 'Acting admin id recorded in the audit log (default: system)' })
  declare admin?: string

  async run() {
    const repo = await resolveTenantRepository()

    try {
      const tenant = await repo.findByIdOrFail(this.tenantId)

      if (!this.force) {
        const verb = this.keepSchema ? 'soft-delete (schema preserved)' : 'destroy (schema dropped)'
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
        try {
          await driver.destroy(tenant)
        } catch (dropErr: any) {
          // Partial failure: the tenant is already soft-deleted (so it is
          // unreachable — isolation is intact), but the schema drop failed,
          // leaving an ORPHAN schema. Don't bury it in the generic catch with a
          // bare error: tell the operator it is recoverable WITHOUT waiting out
          // the retention window, and record the partial state in the audit log.
          this.logger.error(
            `Tenant "${tenant.name}" was soft-deleted but its schema drop FAILED: ` +
              `${dropErr?.message ?? dropErr}. The schema is orphaned (the tenant is already ` +
              `unreachable). Reclaim it with: node ace tenant:purge-expired --include-orphans`
          )
          await auditCliAction(this.logger, {
            tenantId: tenant.id,
            action: 'admin:tenant:destroy',
            adminId: this.admin,
            metadata: { status: tenant.status, schemaDropped: false, orphanSchema: true },
          })
          this.exitCode = 1
          return
        }
      }

      await hooks.run('after', 'destroy', { tenant })
      await TenantDeleted.dispatch(tenant)
      await auditCliAction(this.logger, {
        tenantId: tenant.id,
        action: 'admin:tenant:destroy',
        adminId: this.admin,
        metadata: { status: tenant.status, schemaDropped: !this.keepSchema },
      })

      this.logger.success(`Tenant "${tenant.name}" has been destroyed.`)
    } catch (error) {
      this.logger.error(`Failed to destroy tenant: ${error.message}`)
      this.exitCode = 1
    }
  }
}
