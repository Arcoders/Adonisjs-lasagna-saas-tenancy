import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { TENANT_REPOSITORY } from '@adonisjs-lasagna/saas-tenancy/types'
import type { TenantRepositoryContract } from '@adonisjs-lasagna/saas-tenancy/types'
import BackupService from '../services/backup_service.js'
import { HookRegistry, TenantLogContext } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantBackedUp } from '@adonisjs-lasagna/saas-tenancy/events'

interface BackupTenantPayload {
  tenantId: string
}

export default class BackupTenant extends Job<BackupTenantPayload> {
  static options = { name: 'lasagna.BackupTenant' }

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
