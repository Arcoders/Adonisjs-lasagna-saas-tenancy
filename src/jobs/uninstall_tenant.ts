import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import { DateTime } from 'luxon'
import TenantQueueService from '../services/tenant_queue_service.js'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TenantLogContext from '../services/tenant_log_context.js'
import TenantDeleted from '../events/tenant_deleted.js'

interface UninstallTenantPayload {
  tenantId: string
}

export default class UninstallTenant extends Job<UninstallTenantPayload> {
  async execute(): Promise<void> {
    const { tenantId } = this.payload
    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId }, async () => {
      const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
      const tenant = await repo.findByIdOrFail(tenantId, true)
      const hooks = await app.container.make(HookRegistry)

      logger.info({ tenantId: tenant.id }, 'Uninstalling tenant schema')
      await hooks.run('before', 'destroy', { tenant })

      await new TenantQueueService().destroy(tenant.id)
      await new CircuitBreakerService().destroy(tenant.id)

      const driver = await getActiveDriver()
      await driver.destroy(tenant)
      tenant.deletedAt = DateTime.now()
      await tenant.save()
      logger.info({ tenantId: tenant.id }, 'Tenant uninstalled successfully')

      await hooks.run('after', 'destroy', { tenant })
      await TenantDeleted.dispatch(tenant)
    })
  }

  async failed(error: Error): Promise<void> {
    logger.error({ tenantId: this.payload.tenantId, error: error.message }, 'Failed to uninstall tenant')
  }
}
