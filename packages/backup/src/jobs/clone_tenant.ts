import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import CloneService from '../services/clone_service.js'
import {
  resolveTenantRepository,
  TenantQueueService,
  HookRegistry,
  TenantLogContext,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantCloned } from '@adonisjs-lasagna/saas-tenancy/events'

/**
 * The queue payload for a `CloneTenant` job: the source and destination tenant
 * ids plus the clone options (schema-only and clear-sessions) needed to reproduce
 * the clone on a worker without re-reading any request state.
 */
export interface CloneTenantPayload {
  sourceTenantId: string
  destinationTenantId: string
  schemaOnly: boolean
  clearSessions: boolean
}

/**
 * Queue job that clones one tenant into another. It loads both tenants, runs the
 * before and after `clone` lifecycle hooks around `CloneService.clone`, registers
 * a tenant queue for the new destination, and dispatches the `TenantCloned` event
 * with the copy result, all inside the destination tenant's log context.
 */
export default class CloneTenant extends Job<CloneTenantPayload> {
  static options = { name: 'lasagna.CloneTenant' }

  async execute(): Promise<void> {
    const { sourceTenantId, destinationTenantId, schemaOnly, clearSessions } = this.payload
    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId: destinationTenantId, sourceTenantId }, async () => {
      const repo = await resolveTenantRepository()
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

      ;(await app.container.make(TenantQueueService)).getOrCreate(result.destination.id)

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
