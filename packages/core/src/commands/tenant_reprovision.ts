import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import { auditCliAction } from './audit_cli_action.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import { isProvisionableDriver } from '../services/isolation/driver.js'
import TenantProvisioned from '../events/tenant_provisioned.js'

/**
 * Recovers a tenant stuck in `failed` (a provisioning job threw) or
 * `provisioning` (a job died mid-flight and never flipped the status). Without
 * this, such a tenant was a dead end: the install job had already run and the
 * status floor (`TenantNotReadyException`) keeps serving it a 503 forever.
 *
 * Re-runs the same provision step the install job does — `driver.provision` is
 * idempotent (a second call on an already-provisioned schema must not throw), so
 * this is safe whether the schema was partly created or not. Refuses an active
 * tenant (no-op) and a soft-deleted one (use tenant:destroy/purge instead).
 */
export default class ReprovisionTenant extends BaseCommand {
  static readonly commandName = 'tenant:reprovision'
  static readonly description = 'Re-run provisioning for a failed or stuck-provisioning tenant'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID to reprovision' })
  declare tenantId: string

  @flags.boolean({ description: 'Skip confirmation prompt', alias: 'y', default: false })
  declare force: boolean

  @flags.string({ description: 'Acting admin id recorded in the audit log (default: system)' })
  declare admin?: string

  async run() {
    const repo = await resolveTenantRepository()

    try {
      const tenant = await repo.findByIdOrFail(this.tenantId)

      if (tenant.isDeleted) {
        this.logger.error(
          `Tenant "${tenant.name}" is soft-deleted. Reprovision recovers failed/stuck tenants, ` +
            `not deleted ones — use tenant:purge-expired to reclaim a deleted tenant.`
        )
        this.exitCode = 1
        return
      }
      if (tenant.isActive) {
        this.logger.info(`Tenant "${tenant.name}" is already active. Nothing to do.`)
        return
      }
      if (!tenant.isFailed && !tenant.isProvisioning) {
        this.logger.error(
          `Tenant "${tenant.name}" is "${tenant.status}". Only failed or stuck-provisioning ` +
            `tenants can be reprovisioned.`
        )
        this.exitCode = 1
        return
      }

      if (!this.force) {
        const confirmed = await this.prompt.confirm(
          `Reprovision tenant "${tenant.name}" (current status: ${tenant.status})?`
        )
        if (!confirmed) {
          this.logger.info('Aborted.')
          return
        }
      }

      const hooks = await app.container.make(HookRegistry)
      const driver = await getActiveDriver()
      await hooks.run('before', 'provision', { tenant })
      try {
        tenant.status = 'provisioning'
        await tenant.save()
        if (isProvisionableDriver(driver)) {
          await driver.provision(tenant)
        }
        // Non-provisionable drivers (rowscope-pg) have no per-tenant storage to
        // recreate; recovering the stuck status alone is the whole job here.
        tenant.status = 'active'
        await tenant.save()
      } catch (err) {
        tenant.status = 'failed'
        await tenant.save()
        throw err
      }

      await hooks.run('after', 'provision', { tenant })
      await TenantProvisioned.dispatch(tenant)
      await auditCliAction(this.logger, {
        tenantId: tenant.id,
        action: 'admin:tenant:reprovision',
        adminId: this.admin,
        metadata: { status: tenant.status },
      })

      this.logger.success(`Tenant "${tenant.name}" reprovisioned and is now active.`)
    } catch (error: any) {
      this.logger.error(`Failed to reprovision tenant: ${error?.message ?? error}`)
      this.exitCode = 1
    }
  }
}
