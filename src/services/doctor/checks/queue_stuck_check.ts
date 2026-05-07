import { getConfig } from '../../../config.js'
import TenantQueueService from '../../tenant_queue_service.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const FAILED_THRESHOLD = 1
const DELAYED_THRESHOLD = 50
const DEFAULT_STALLED_MINUTES = 10

const queueStuckCheck: DoctorCheck = {
  name: 'queue_health',
  description:
    'Flags tenant queues with failed jobs, delayed backlogs, or jobs that have been active for too long (stalled).',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const svc = new TenantQueueService()
    const issues: DiagnosisIssue[] = []
    const stalledMinutes =
      getConfig().doctor?.queueStalledMinutes ?? DEFAULT_STALLED_MINUTES
    const stalledMs = stalledMinutes * 60_000

    for (const tenant of ctx.tenants) {
      if (!tenant.isActive && !tenant.isSuspended) continue
      try {
        const stats = await svc.getStats(tenant.id)
        if (stats.failed >= FAILED_THRESHOLD) {
          issues.push({
            code: 'queue_failed_jobs',
            severity: 'warn',
            message: `Tenant "${tenant.name}" queue has ${stats.failed} failed job(s)`,
            tenantId: tenant.id,
            meta: { ...stats },
          })
        }
        if (stats.delayed >= DELAYED_THRESHOLD) {
          issues.push({
            code: 'queue_delayed_backlog',
            severity: 'warn',
            message: `Tenant "${tenant.name}" queue has ${stats.delayed} delayed jobs (threshold ${DELAYED_THRESHOLD})`,
            tenantId: tenant.id,
            meta: { ...stats },
          })
        }

        // Stalled detection: any job in `active` state whose `processedOn`
        // timestamp is older than `stalledMs` is considered stuck — typically
        // because the worker that picked it up died without releasing it.
        if (stats.active > 0) {
          const queue = svc.getOrCreate(tenant.id)
          const activeJobs = await queue.getActive(0, 50)
          const now = Date.now()
          const stalled = activeJobs.filter((j) => {
            const startedAt = j.processedOn ?? j.timestamp
            return typeof startedAt === 'number' && now - startedAt > stalledMs
          })
          if (stalled.length > 0) {
            issues.push({
              code: 'queue_stalled',
              severity: 'warn',
              message: `Tenant "${tenant.name}" has ${stalled.length} job(s) active for > ${stalledMinutes}m`,
              tenantId: tenant.id,
              meta: {
                stalledCount: stalled.length,
                stalledMinutes,
                jobIds: stalled.slice(0, 10).map((j) => j.id),
              },
            })
          }
        }
      } catch (error: any) {
        issues.push({
          code: 'queue_inspect_failed',
          severity: 'info',
          message: `Could not inspect queue for "${tenant.name}": ${error?.message ?? 'unknown'}`,
          tenantId: tenant.id,
        })
      }
    }

    return issues
  },
}

export default queueStuckCheck
