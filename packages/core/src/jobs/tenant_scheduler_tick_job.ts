import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import TenantSchedulerService from '../services/tenant_scheduler_service.js'
import { SCHEDULER_TICK_JOB_NAME } from '../sdk/plugin_keys.js'

interface TenantSchedulerTickPayload {
  /** The registered schedule this tick is firing (a `ScheduleName` value). */
  scheduleName: string
}

/**
 * Global (cross-tenant) queue job that runs ONE schedule's tick. The native
 * `@adonisjs/queue` scheduler, armed by {@link TenantSchedulerService.start},
 * dispatches this job on the schedule's cadence; the host's `queue:work` worker
 * claims the due schedule atomically, so it is DISPATCHED once per interval across
 * every pod (the tick body itself runs at-least-once — retry / stall recovery).
 *
 * It does NOT extend `TenantJob` — a tick is not scoped to one tenant; it fans
 * out over every ACTIVE tenant inside `runTick`. Registered on the `@adonisjs/queue`
 * Locator by the provider's `#registerQueueJobs()` (via `jobs/index.ts`).
 */
export default class TenantSchedulerTickJob extends Job<TenantSchedulerTickPayload> {
  // Single-sourced with the schedule-arming code so the name the worker
  // dispatches and the name the schedule points at can never disagree.
  // `maxRetries` is set explicitly: the boringnode default is 0, so without it a
  // tick that fails to enumerate tenants (a transient DB blip) would fail
  // PERMANENTLY and skip the whole interval. With it, the worker retries the tick
  // so that interval's fan-out still happens — the reconciling recovery the docs
  // promise. Per-tenant dispatch stays fail-open, so a retry only re-runs the
  // enumeration, not already-succeeded per-tenant work (deduped best-effort by
  // the per-tenant jobId within the period).
  static options = { name: SCHEDULER_TICK_JOB_NAME, maxRetries: 3 }

  async execute(): Promise<void> {
    const { scheduleName } = this.payload
    const scheduler = await app.container.make(TenantSchedulerService)
    const result = await scheduler.runTick(scheduleName)
    if (!result.found) return
    logger.info(
      { schedule: result.schedule, dispatched: result.dispatched, failed: result.failed },
      'Tenant scheduler tick dispatched'
    )
  }

  async failed(error: Error): Promise<void> {
    logger.error(
      { schedule: this.payload.scheduleName, error: error.message },
      'Tenant scheduler tick failed'
    )
  }
}
