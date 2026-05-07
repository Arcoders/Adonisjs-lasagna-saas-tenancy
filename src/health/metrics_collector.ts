import app from '@adonisjs/core/services/app'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import TenantQueueService from '../services/tenant_queue_service.js'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type {
  TenantRepositoryContract,
  TenantStatus,
  TenantModelContract,
} from '../types/contracts.js'
import type { MetricsSnapshot } from './metrics_exporter.js'

const STATUSES: TenantStatus[] = ['provisioning', 'active', 'suspended', 'failed', 'deleted']

interface CollectOptions {
  /** Skip the tenants registry query (useful when DB is unreachable). */
  includeTenants?: boolean
  /** Skip queue stats lookup (BullMQ can be slow). */
  includeQueues?: boolean
}

const startedAt = Date.now()

export async function collectSnapshot(options: CollectOptions = {}): Promise<MetricsSnapshot> {
  const { includeTenants = true, includeQueues = true } = options

  const tenantsByStatus: Record<string, number> = {}
  for (const s of STATUSES) tenantsByStatus[s] = 0
  let tenantsTotal = 0

  // The /metrics endpoint must always respond — it's polled by Prometheus
  // and a hard failure cascades into alerts about the alerting system. So
  // every section below catches and surfaces zeros on error, but logs a
  // warn so the degradation is visible.
  if (includeTenants) {
    try {
      const repo = (await app.container.make(
        TENANT_REPOSITORY as any
      )) as TenantRepositoryContract
      const tenants = await repo.all({ includeDeleted: true })
      tenantsTotal = tenants.length
      for (const t of tenants as TenantModelContract[]) {
        tenantsByStatus[t.status] = (tenantsByStatus[t.status] ?? 0) + 1
      }
    } catch (err) {
      await warn('tenants_unavailable', err)
    }
  }

  let circuits = {}
  try {
    const cb = await app.container.make(CircuitBreakerService)
    circuits = cb.getAllMetrics()
  } catch (err) {
    await warn('circuit_breaker_service_unavailable', err)
  }

  let queues: any[] = []
  if (includeQueues) {
    try {
      const qs = new TenantQueueService()
      queues = await qs.getAllStats()
    } catch (err) {
      await warn('queue_stats_unavailable', err)
    }
  }

  return {
    tenantsTotal,
    tenantsByStatus,
    circuits,
    queues,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }
}

async function warn(kind: string, err: unknown): Promise<void> {
  const message = (err as Error)?.message ?? String(err)
  try {
    const logger = await app.container.make('logger').catch(() => undefined)
    if (logger) {
      logger.warn(
        { collector: 'health.metrics', kind, error: message },
        'multitenancy: metrics collector degraded — surfacing zeros for this section'
      )
      return
    }
  } catch {
    // Logger itself is broken — fall through to console as a last resort.
  }
  console.warn(`[multitenancy] metrics collector ${kind}: ${message}`)
}
