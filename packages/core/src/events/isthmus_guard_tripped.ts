import { BaseEvent } from '@adonisjs/core/events'
import type { IsthmusGuardTrippedPayload } from '../types/isthmus.js'

/**
 * Domain event dispatched (best-effort, rate-limited, fire-and-forget) whenever a
 * registered Isthmus guard rejects: a malformed tenant identifier, a CR/LF redirect
 * path, a tenant-context mismatch, and every other entry in the Isthmus registry.
 * The payload carries the guard's registry fields (`id`, `pillar`, `bugClass`,
 * `severity`, the taxonomy `event` name) plus the tenant id and metadata from the
 * trip site, so hosts can alert on e.g. `severity === 'critical'` or a specific
 * `event` such as `isthmus:seal:tenant:mismatch`.
 *
 * Listeners run on the emitter's promise chain, decoupled from the guard's reject
 * path. The guard never waits on them. Keep listeners light: heavy synchronous
 * work delays other listeners of the same event.
 *
 * @property payload - The tripped guard's registry fields plus trip-site context.
 */
export default class IsthmusGuardTripped extends BaseEvent {
  constructor(readonly payload: IsthmusGuardTrippedPayload) {
    super()
  }
}
