import PluginException, { type PluginExceptionContext } from './plugin_exception.js'

/** Attribution for a scheduler tick failure. */
export interface SchedulerTickContext extends PluginExceptionContext {
  /** The schedule whose tick failed. */
  schedule?: string
}

/**
 * Thrown when a scheduler tick fails CATASTROPHICALLY — the tenant enumeration
 * itself throws, not a single tenant's dispatch. A per-tenant dispatch failure is
 * caught inside the fan-out loop (log + metric + continue, fail-open), so it never
 * reaches here; this is the fail-closed path for a broken tick, which lets the
 * worker retry the whole tick per its backoff. The offending schedule rides as
 * `schedule` and the original error as `cause`.
 */
export default class SchedulerTickException extends PluginException {
  static status = 500
  static code = 'E_SCHEDULER_TICK'

  readonly schedule?: string

  constructor(message: string, context: SchedulerTickContext = {}) {
    super(message, { plugin: context.plugin, cause: context.cause })
    this.schedule = context.schedule
  }
}
