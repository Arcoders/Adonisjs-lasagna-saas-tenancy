import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import BackupService from '../services/backup_service.js'
import HookRegistry from '../services/hook_registry.js'
import TenantLogContext from '../services/tenant_log_context.js'
import TenantBackedUp from '../events/tenant_backed_up.js'

interface BackupTenantPayload {
  tenantId: string
}

export default class BackupTenant extends Job<BackupTenantPayload> {
  async execute(): Promise<void> {
    const { tenantId } = this.payload
    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId }, async () => {
      const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
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
    logger.error({ tenantId: this.payload.tenantId, error: error.message }, 'Failed to backup tenant')
  }
}
