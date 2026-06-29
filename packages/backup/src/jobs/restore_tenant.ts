import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import BackupService from '../services/backup_service.js'
import {
  resolveTenantRepository,
  HookRegistry,
  TenantLogContext,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantRestored } from '@adonisjs-lasagna/saas-tenancy/events'

interface RestoreTenantPayload {
  tenantId: string
  fileName: string
}

/**
 * Queue job that restores a single tenant from a named backup archive. It
 * resolves the tenant, runs the before and after `restore` lifecycle hooks around
 * `BackupService.restore`, and dispatches the `TenantRestored` event, all within
 * the tenant's log context so the restore is attributable to that tenant.
 */
export default class RestoreTenant extends Job<RestoreTenantPayload> {
  static options = { name: 'lasagna.RestoreTenant' }

  async execute(): Promise<void> {
    const { tenantId, fileName } = this.payload
    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId }, async () => {
      const repo = await resolveTenantRepository()
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
    logger.error({ tenantId, file: fileName, error: error.message }, 'Failed to restore tenant')
  }
}
