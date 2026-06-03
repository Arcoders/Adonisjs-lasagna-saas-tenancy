import { Queue, type JobsOptions } from 'bullmq'
import logger from '@adonisjs/core/services/logger'
import { getConfig } from '../config.js'

export interface TenantQueueStats {
  tenantId: string
  queueName: string
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

export default class TenantQueueService {
  private queues = new Map<string, Queue>()

  getQueueName(tenantId: string): string {
    return `${getConfig().queue.tenantQueuePrefix}${tenantId}`
  }

  getOrCreate(tenantId: string): Queue {
    if (this.queues.has(tenantId)) {
      return this.queues.get(tenantId)!
    }

    const { redis: conn, attempts } = getConfig().queue

    const queue = new Queue(this.getQueueName(tenantId), {
      connection: {
        host: conn.host,
        port: conn.port,
        username: conn.username ?? undefined,
        password: conn.password ?? undefined,
        db: conn.db ?? 0,
      },
      defaultJobOptions: {
        attempts,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    })

    logger.debug({ tenantId, queueName: this.getQueueName(tenantId) }, 'Tenant queue created')
    this.queues.set(tenantId, queue)
    return queue
  }

  async getStats(tenantId: string): Promise<TenantQueueStats> {
    const queue = this.getOrCreate(tenantId)
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')
    return {
      tenantId,
      queueName: this.getQueueName(tenantId),
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    }
  }

  async getAllStats(): Promise<TenantQueueStats[]> {
    const results: TenantQueueStats[] = []
    for (const [tenantId] of this.queues) {
      results.push(await this.getStats(tenantId))
    }
    return results
  }

  async dispatch<T extends Record<string, unknown>>(
    tenantId: string,
    jobName: string,
    payload: T,
    opts?: JobsOptions
  ): Promise<void> {
    const queue = this.getOrCreate(tenantId)
    await queue.add(jobName, payload, opts)
  }

  async destroy(tenantId: string): Promise<void> {
    const queue = this.queues.get(tenantId)
    if (!queue) return
    try {
      await queue.obliterate({ force: true })
      await queue.close()
      logger.info({ tenantId }, 'Tenant queue destroyed')
    } catch (error) {
      logger.warn({ tenantId, error: (error as Error).message }, 'Failed to destroy tenant queue')
    } finally {
      this.queues.delete(tenantId)
    }
  }
}
