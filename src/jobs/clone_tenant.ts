import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import CloneService from '../services/clone_service.js'
import TenantQueueService from '../services/tenant_queue_service.js'
import HookRegistry from '../services/hook_registry.js'
import TenantLogContext from '../services/tenant_log_context.js'
import TenantCloned from '../events/tenant_cloned.js'

export interface CloneTenantPayload {
  sourceTenantId: string
  destinationTenantId: string
  schemaOnly: boolean
  clearSessions: boolean
}

export default class CloneTenant extends Job<CloneTenantPayload> {
  async execute(): Promise<void> {
    const { sourceTenantId, destinationTenantId, schemaOnly, clearSessions } = this.payload
    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId: destinationTenantId, sourceTenantId }, async () => {
      const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
      const [source, destination] = await Promise.all([
        repo.findByIdOrFail(sourceTenantId),
        repo.findByIdOrFail(destinationTenantId),
      ])
      const hooks = await app.container.make(HookRegistry)

      logger.info({ sourceId: source.id, destId: destination.id }, 'CloneTenant job started')
      await hooks.run('before', 'clone', { source, destination })

      const result = await new CloneService().clone(source, destination, {
        schemaOnly,
        clearSessions,
      })

      new TenantQueueService().getOrCreate(result.destination.id)

      logger.info(
        {
          sourceId: source.id,
          destId: destination.id,
          tablesCopied: result.tablesCopied,
          rowsCopied: result.rowsCopied,
        },
        'CloneTenant job completed'
      )

      await hooks.run('after', 'clone', { source, destination, result })
      await TenantCloned.dispatch(source, destination, result)
    })
  }

  async failed(error: Error): Promise<void> {
    const { sourceTenantId, destinationTenantId } = this.payload
    logger.error(
      {
        sourceId: sourceTenantId,
        destId: destinationTenantId,
        error: error.message,
      },
      'CloneTenant job failed'
    )
  }
}
