import type { ScheduleName } from './brands.js'

/**
 * Single source for the plugin-platform scheduler identifiers ("nothing
 * wired"): the deterministic native schedule id (`lasagna.scheduler.<name>`) and
 * the tick job name (`lasagna.TenantSchedulerTick`). Both are `lasagna.`-namespaced,
 * so the `check-plugin-keys` guard fails the build if either literal is constructed
 * anywhere else. The per-tenant dispatch id ({@link schedulerJobId}) also lives
 * here for one home, but it carries no namespace and is best-effort, so the guard
 * does not police it.
 *
 * Idempotent upsert and dispatch depend on the producer (the scheduler service)
 * and the consumer (the worker firing the tick) computing the SAME id.
 *
 * Every builder takes a branded {@link ScheduleName} (minted through
 * `scheduleName()`, which runs the identifier guard), so a raw string can never
 * reach a schedule id or a job id here.
 */

/**
 * The `@adonisjs/queue` (boringnode) job name for the global scheduler tick. The
 * tick job's `static options.name` and the schedule-arming code both reference
 * THIS constant, so the name the worker dispatches and the name the schedule
 * points at can never disagree. Namespaced (`lasagna.`) so a host app's own job
 * of the same purpose does not collide on the shared Locator singleton.
 */
export const SCHEDULER_TICK_JOB_NAME = 'lasagna.TenantSchedulerTick'

/** Namespace prefix for every native schedule this package arms. */
const SCHEDULE_ID_PREFIX = 'lasagna.scheduler.'

/**
 * Deterministic id for the native `@adonisjs/queue` schedule backing a registered
 * plugin schedule. Deterministic (a pure function of the schedule name) so
 * `start()` UPSERTS the same schedule row on every pod and every redeploy instead
 * of creating a duplicate. The boringnode adapter keys its upsert on this id.
 */
export function schedulerScheduleId(name: ScheduleName): string {
  return `${SCHEDULE_ID_PREFIX}${name}`
}

/**
 * Best-effort BullMQ dedup id for a single tenant's dispatch inside one tick.
 * `<schedule>:<tenantId>:<period>`, where the `period` is a coarse time bucket, so a
 * tick that is RETRIED by the worker within the same bucket re-dispatches the
 * same id and BullMQ drops the duplicate. It is deliberately best-effort: BullMQ
 * retains a completed id only for `removeOnComplete` jobs, so the real
 * correctness for critical work is a reconciling schedule (see the guide), not
 * this id.
 */
export function schedulerJobId(name: ScheduleName, tenantId: string, period: number): string {
  return `${name}:${tenantId}:${period}`
}
