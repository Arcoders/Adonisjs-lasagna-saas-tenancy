import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import BackupService from '../services/backup_service.js'
import {
  resolveTenantRepository,
  HookRegistry,
  TenantLogContext,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantBackedUp } from '@adonisjs-lasagna/saas-tenancy/events'

interface BackupTenantPayload {
  tenantId: string
}

/**
 * Queue job that backs up a single tenant. It resolves the tenant, runs the
 * before and after `backup` lifecycle hooks around `BackupService.backup`, and
 * dispatches the `TenantBackedUp` event with the resulting archive metadata, all
 * inside the tenant's log context so the work is attributable to that tenant.
 */
export default class BackupTenant extends Job<BackupTenantPayload> {
  static options = { name: 'lasagna.BackupTenant' }

  async execute(): Promise<void> {
    const { tenantId } = this.payload
    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId }, async () => {
      const repo = await resolveTenantRepository()
      const tenant = await repo.findByIdOrFail(tenantId)
      const hooks = await app.container.make(HookRegistry)

      logger.info({ tenantId: tenant.id }, 'Starting tenant backup')
      await hooks.run('before', 'backup', { tenant })

      const meta = await new BackupService().backup(tenant)

      logger.info({ tenantId: tenant.id, file: meta.file }, 'Tenant backup completed')

      await hooks.run('after', 'backup', { tenant, metadata: meta })
      await TenantBackedUp.dispatch(tenant, meta)
    })
  }

  async failed(error: Error): Promise<void> {
    logger.error(
      { tenantId: this.payload.tenantId, error: error.message },
      'Failed to backup tenant'
    )
  }
}
