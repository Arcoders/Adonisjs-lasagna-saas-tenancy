import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

export interface DependencyUnavailableContext {
  /** Logical dependency name, like `'redis'`, `'postgres'` or `'stripe'`. */
  dependency: string
  /** Operation label, e.g. `'quota.consume'`. */
  operation: string
  tenantId?: string
}

/**
 * Thrown by `ResilienceService.run()` when a dependency configured as
 * `fail-closed` errors, meaning Redis, Postgres or similar is unavailable. It
 * carries a `503` and a `Retry-After` hint so callers and HTTP clients back off
 * instead of seeing an opaque `500` from a raw driver error.
 *
 * Catch it where you want a custom degraded response. Otherwise the default
 * `handle()` renders a 503 with a `Retry-After`.
 */
export default class DependencyUnavailableException extends Exception {
  static readonly status = 503
  static readonly code = 'E_DEPENDENCY_UNAVAILABLE'

  readonly dependency: string
  readonly operation: string
  readonly tenantId?: string
  /** Retry-After hint (seconds) surfaced on the HTTP response. */
  retryAfterSeconds = 5

  constructor(ctx: DependencyUnavailableContext) {
    super(
      `Dependency "${ctx.dependency}" is unavailable (operation "${ctx.operation}"). Please retry shortly.`,
      { status: 503, code: 'E_DEPENDENCY_UNAVAILABLE' }
    )
    this.dependency = ctx.dependency
    this.operation = ctx.operation
    this.tenantId = ctx.tenantId
  }

  async handle(error: this, ctx: HttpContext): Promise<void> {
    ctx.response
      .status(error.status)
      .header('Retry-After', String(error.retryAfterSeconds))
      .send({ errors: [{ code: error.code, message: error.message }] })
  }
}
