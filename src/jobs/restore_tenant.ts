import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import BackupService from '../services/backup_service.js'
import HookRegistry from '../services/hook_registry.js'
import TenantLogContext from '../services/tenant_log_context.js'
import TenantRestored from '../events/tenant_restored.js'

interface RestoreTenantPayload {
  tenantId: string
  fileName: string
}

export default class RestoreTenant extends Job<RestoreTenantPayload> {
  async execute(): Promise<void> {
    const { tenantId, fileName } = this.payload
    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId }, async () => {
      const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
      const tenant = await repo.findByIdOrFail(tenantId)
      const hooks = await app.container.make(HookRegistry)

      logger.info({ tenantId: tenant.id, file: fileName }, 'Starting tenant restore')
      await hooks.run('before', 'restore', { tenant, fileName })

      await new BackupService().restore(tenant, fileName)

      logger.info({ tenantId: tenant.id, file: fileName }, 'Tenant restore completed')

      await hooks.run('after', 'restore', { tenant, fileName })
      await TenantRestored.dispatch(tenant, fileName)
    })
  }

  async failed(error: Error): Promise<void> {
    const { tenantId, fileName } = this.payload
    logger.error(
      { tenantId, file: fileName, error: error.message },
      'Failed to restore tenant'
    )
  }
}
