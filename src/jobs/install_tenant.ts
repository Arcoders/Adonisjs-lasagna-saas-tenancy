import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import TenantQueueService from '../services/tenant_queue_service.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TenantLogContext from '../services/tenant_log_context.js'
import TenantProvisioned from '../events/tenant_provisioned.js'

interface InstallTenantPayload {
  tenantId: string
}

export default class InstallTenant extends Job<InstallTenantPayload> {
  async execute(): Promise<void> {
    const { tenantId } = this.payload
    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId }, async () => {
      const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
      const tenant = await repo.findByIdOrFail(tenantId)
      const hooks = await app.container.make(HookRegistry)

      logger.info({ tenantId: tenant.id }, 'Provisioning tenant schema')
      await hooks.run('before', 'provision', { tenant })

      const driver = await getActiveDriver()
      try {
        tenant.status = 'provisioning'
        await tenant.save()
        await driver.provision(tenant)
        tenant.status = 'active'
        await tenant.save()
      } catch (error) {
        tenant.status = 'failed'
        await tenant.save()
        throw error
      }
      logger.info({ tenantId: tenant.id }, 'Tenant provisioned successfully')

      new TenantQueueService().getOrCreate(tenant.id)
      logger.info({ tenantId: tenant.id }, 'Tenant queue initialized')

      await hooks.run('after', 'provision', { tenant })
      await TenantProvisioned.dispatch(tenant)
    })
  }

  async failed(error: Error): Promise<void> {
    logger.error({ tenantId: this.payload.tenantId, error: error.message }, 'Failed to install tenant')
  }
}
