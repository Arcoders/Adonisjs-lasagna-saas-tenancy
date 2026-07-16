import type { ScheduleName } from '../sdk/brands.js'
import type { TenantStatus, TenantRepositoryContract } from '../types/contracts.js'
import { schedulerScheduleId, schedulerJobId } from '../sdk/plugin_keys.js'
import PluginBootException from '../exceptions/plugin_boot_exception.js'
import SchedulerTickException from '../exceptions/scheduler_tick_exception.js'
import TenantQueueService from './tenant_queue_service.js'

// Lazy logger so importing this service never triggers `@adonisjs/core`'s
// top-level `await app.booted(...)` outside an Ignitor (which throws). Same
// pattern as CircuitBreakerService / TenantQueueService. Keeps the module
// importable from unit tests without an Ignitor.
const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/**
 * Tenant statuses a tick fans out to by default: only ACTIVE tenants. A
 * provisioning / suspended / failed / deleted tenant has no business running
 * scheduled work, so the status filter gives that skip for free (a schedule can
 * widen it via `statuses`). `as const satisfies` so the list stays a subset of
 * the real status union and can never drift.
 */
export const SCHEDULER_ACTIVE_STATUSES = ['active'] as const satisfies readonly TenantStatus[]

/** Job-id time bucket (ms) for a cron schedule (no fixed interval to derive from). */
const CRON_JOBID_BUCKET_MS = 60_000

/**
 * One registered schedule. Discriminated by `kind`, every field `readonly`,
 * `name` branded (minted via `scheduleName()`), so a raw string cannot reach the
 * slot that becomes a schedule id / job id. Exactly one of `cron` / `everyMs`
 * must be set. `register()` fails closed otherwise.
 *
 * A tick fans out over ACTIVE tenants and dispatches `job` (a per-tenant BullMQ
 * job name) to each one's queue via {@link TenantQueueService}. The scheduler
 * itself stays on the umbrella ABI (no per-surface contract version): it is a
 * declarative fan-out helper, not a pluggable request-path surface.
 */
export interface TenantSchedule {
  readonly kind: 'schedule'
  readonly name: ScheduleName
  /** The per-tenant BullMQ job name dispatched to each active tenant's queue. */
  readonly job: string
  /** Cron expression (mutually exclusive with {@link everyMs}). */
  readonly cron?: string
  /** Fixed interval in ms (mutually exclusive with {@link cron}). */
  readonly everyMs?: number
  /** IANA timezone for cron evaluation. Defaults to UTC. */
  readonly timezone?: string
  /** Tenant statuses to fan out to. Defaults to {@link SCHEDULER_ACTIVE_STATUSES}. */
  readonly statuses?: readonly TenantStatus[]
  /** Upper bound (ms) on the random per-tenant dispatch delay that spreads the
   *  fan-out so 10k tenants do not all fire in the same instant. Defaults to 0. */
  readonly jitterMs?: number
  /** Static payload merged into every per-tenant dispatch. */
  readonly payload?: Record<string, unknown>
  /**
   * Delivery semantics, INFORMATIONAL (the framework does not branch on it; it is
   * documented so the author picks knowingly). `reconciling` = idempotent/catch-up
   * work where a missed tick self-heals on the next one; `fire-once` = time-specific
   * work that must not double-fire. Defaults to `reconciling`.
   */
  readonly deliveryGuarantee?: 'reconciling' | 'fire-once'
}

/** Outcome of one {@link TenantSchedulerService.runTick} fan-out. */
export interface SchedulerTickResult {
  readonly schedule: string
  readonly dispatched: number
  readonly failed: number
  /** False when the named schedule was not registered (tick is a no-op). */
  readonly found: boolean
}

/**
 * Fans a periodic tick out over active tenants. Bound as a container singleton by
 * `MultitenancyProvider`; plugins register schedules in their `boot()` (through
 * the `definePlugin({ schedules })` facade). Map-backed (stateful): resolve via
 * `container.make`, never `new`.
 *
 * The firing mechanism is the native `@adonisjs/queue` scheduler: `start()` arms
 * one native schedule per registered entry pointing at the global tick job, and
 * the host's `queue:work` worker fires it. That worker claims a due schedule
 * ATOMICALLY (`claimDueSchedule`), so the schedule is claimed and the tick
 * DISPATCHED once per interval across every pod. No advisory lock is needed. The
 * dispatched tick BODY still runs at-least-once (retry / stall recovery), so the
 * per-tenant dispatch carries a best-effort deterministic `jobId` for dedup; the
 * real correctness for critical work is a reconciling schedule (see
 * `docs/guides/scheduler.md`).
 */
export default class TenantSchedulerService {
  readonly #schedules = new Map<ScheduleName, TenantSchedule>()

  /**
   * Register a schedule. Fails closed (aborting boot) on a duplicate name or when
   * the cron/interval is not EXACTLY one of `cron` / `everyMs`. A schedule with
   * neither would never fire and one with both is ambiguous.
   */
  register(schedule: TenantSchedule): this {
    if (this.#schedules.has(schedule.name)) {
      throw new PluginBootException(
        `A tenant schedule named "${schedule.name}" is already registered.`,
        {
          plugin: String(schedule.name),
          phase: 'schedules',
        }
      )
    }
    const hasCron = typeof schedule.cron === 'string' && schedule.cron.length > 0
    const hasEvery = typeof schedule.everyMs === 'number'
    if (hasCron === hasEvery) {
      throw new PluginBootException(
        `Tenant schedule "${schedule.name}" must set exactly one of "cron" or "everyMs".`,
        { plugin: String(schedule.name), phase: 'schedules' }
      )
    }
    if (hasEvery && (!Number.isFinite(schedule.everyMs) || (schedule.everyMs ?? 0) < 1)) {
      throw new PluginBootException(
        `Tenant schedule "${schedule.name}" everyMs must be a finite integer >= 1.`,
        { plugin: String(schedule.name), phase: 'schedules' }
      )
    }
    this.#schedules.set(schedule.name, schedule)
    return this
  }

  unregister(name: ScheduleName): boolean {
    return this.#schedules.delete(name)
  }

  has(name: ScheduleName): boolean {
    return this.#schedules.has(name)
  }

  get(name: ScheduleName): TenantSchedule | undefined {
    return this.#schedules.get(name)
  }

  list(): readonly ScheduleName[] {
    return [...this.#schedules.keys()]
  }

  /**
   * Arm every registered schedule as a native `@adonisjs/queue` schedule. Called
   * in the provider's `ready()`, after all plugins have registered. Idempotent:
   * each schedule upserts by a deterministic id, so re-arming on another pod or a
   * redeploy updates in place rather than duplicating.
   *
   * No-op when no schedules are registered.
   *
   * `failClosed` (default true) controls what an arm failure does. In the worker /
   * console process (the one that actually RUNS schedules) it is true: a declared
   * schedule that cannot be armed aborts the deploy rather than silently never
   * running. In the `web` process it is passed false: the schedule row is persisted
   * in the shared queue backend, so the worker arms it anyway; failing the web pod's
   * readiness on a transient queue-backend blip would take the API down for requests
   * that never touch the queue. There the failure is logged loudly and boot continues.
   */
  async start(options: { failClosed?: boolean } = {}): Promise<void> {
    if (this.#schedules.size === 0) return
    const failClosed = options.failClosed ?? true
    for (const schedule of this.#schedules.values()) {
      try {
        await this.armSchedule(schedule)
      } catch (error) {
        if (failClosed) {
          throw new PluginBootException(
            `Failed to arm tenant schedule "${schedule.name}". Is @adonisjs/queue configured?`,
            { plugin: String(schedule.name), phase: 'schedules', cause: error }
          )
        }
        // web process: don't take the pod down for a queue-backend blip. The
        // worker's fail-closed arm is the real deploy gate. Log loud, keep booting.
        ;(await lazyLogger())?.error(
          {
            schedule: String(schedule.name),
            err: (error as Error)?.message ?? String(error),
          },
          'Failed to arm tenant schedule (fail-open in web; the worker arms it)'
        )
        return
      }
    }
    ;(await lazyLogger())?.info(
      { schedules: this.#schedules.size },
      'Tenant scheduler armed native schedules'
    )
  }

  /**
   * Create/upsert the native schedule backing one entry. A protected seam so a
   * unit test can subclass and assert arming without a live queue backend. Points
   * the schedule at the global tick job carrying this schedule's name.
   */
  protected async armSchedule(schedule: TenantSchedule): Promise<void> {
    const { default: TenantSchedulerTickJob } = await import('../jobs/tenant_scheduler_tick_job.js')
    const builder = TenantSchedulerTickJob.schedule({ scheduleName: String(schedule.name) }).id(
      schedulerScheduleId(schedule.name)
    )
    if (schedule.cron) builder.cron(schedule.cron)
    else builder.every(schedule.everyMs ?? 0)
    if (schedule.timezone) builder.timezone(schedule.timezone)
    await builder.run()
  }

  /**
   * Fan one tick out over the tenants matching the schedule's status filter,
   * dispatching its per-tenant job to each. Called by the global tick job.
   *
   * Fail-OPEN per tenant: a single tenant's dispatch failure is caught INSIDE the
   * `each` callback (a throw there aborts the whole cursor, see
   * `TenantRepositoryContract.each`), logged with context, and the fan-out
   * continues. A catastrophic failure (the enumeration itself throws) propagates
   * as a {@link SchedulerTickException} so the worker retries the whole tick.
   */
  async runTick(name: string): Promise<SchedulerTickResult> {
    const schedule = [...this.#schedules.values()].find((s) => s.name === name)
    if (!schedule) {
      ;(await lazyLogger())?.warn(
        { schedule: name },
        'Scheduler tick fired for an unregistered schedule; skipping'
      )
      return { schedule: name, dispatched: 0, failed: 0, found: false }
    }

    const statuses = schedule.statuses ?? SCHEDULER_ACTIVE_STATUSES
    const period = this.periodBucket(schedule)
    let dispatched = 0
    let failed = 0

    try {
      const [repo, queue] = await Promise.all([this.resolveRepo(), this.resolveQueue()])
      await repo.each(
        async (tenant) => {
          try {
            await queue.dispatch(
              tenant.id,
              schedule.job,
              { ...schedule.payload },
              {
                jobId: schedulerJobId(schedule.name, tenant.id, period),
                delay: this.jitterDelay(schedule.jitterMs ?? 0),
              }
            )
            dispatched++
          } catch (error) {
            // Fail-open: keep the fan-out going. This catch MUST stay inside the
            // callback. `each` aborts iteration on a thrown callback, so without
            // it one bad tenant would silently starve every later tenant.
            failed++
            ;(await lazyLogger())?.error(
              {
                tenantId: tenant.id,
                schedule: schedule.name,
                job: schedule.job,
                err: (error as Error)?.message ?? String(error),
              },
              'Scheduler tick: tenant dispatch failed; continuing (fail-open)'
            )
          }
        },
        { statuses: [...statuses] }
      )
    } catch (error) {
      throw new SchedulerTickException(
        `Scheduler tick for "${schedule.name}" failed while enumerating tenants.`,
        { plugin: String(schedule.name), schedule: String(schedule.name), cause: error }
      )
    }

    ;(await lazyLogger())?.info(
      { schedule: schedule.name, dispatched, failed },
      'Scheduler tick complete'
    )
    return { schedule: String(schedule.name), dispatched, failed, found: true }
  }

  // --- protected seams (overridden in unit tests to run without PG/Redis) ---

  /** Resolve the host's tenant repository. Lazy so the module stays unit-importable. */
  protected async resolveRepo(): Promise<TenantRepositoryContract> {
    const { resolveTenantRepository } = await import('./resolve_tenant_repository.js')
    return resolveTenantRepository()
  }

  /** Resolve the per-tenant BullMQ dispatch service from the container. */
  protected async resolveQueue(): Promise<TenantQueueService> {
    const app = (await import('@adonisjs/core/services/app')).default
    return app.container.make(TenantQueueService)
  }

  /** Clock seam so tests can pin the job-id period bucket deterministically. */
  protected now(): number {
    return Date.now()
  }

  /** Random jitter delay (ms) in `[0, maxMs)`. A seam so tests get a stable 0. */
  protected jitterDelay(maxMs: number): number {
    if (maxMs <= 0) return 0
    return Math.floor(Math.random() * maxMs)
  }

  /**
   * Coarse time bucket that labels this tick's period for the per-tenant dedup
   * `jobId`. Interval schedules bucket by their own cadence; cron schedules use a
   * one-minute bucket. Best-effort by design (see {@link schedulerJobId}).
   */
  protected periodBucket(schedule: TenantSchedule): number {
    const bucketMs =
      typeof schedule.everyMs === 'number' && schedule.everyMs > 0
        ? schedule.everyMs
        : CRON_JOBID_BUCKET_MS
    return Math.floor(this.now() / bucketMs)
  }
}
