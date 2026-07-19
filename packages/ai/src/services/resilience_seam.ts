import type { ResilienceRunOptions } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * The resilience seam: one closure, structurally the kernel `ResilienceService.run`,
 * injected into every service that makes a request-path Redis read so a dependency
 * outage degrades by a named POLICY rather than an ad-hoc per-call `try/catch`. The
 * `ResilienceRunOptions` type is imported type-only (erased at build), so a module
 * that holds a `RunResilient` never value-imports the eager core `/services` barrel;
 * the AI provider (the one sanctioned toucher of that barrel) binds the real
 * `ResilienceService.run` at wiring time.
 *
 * On `fail-open` the kernel service swallows the failure and returns `fallback()`; on
 * `fail-closed` it throws `DependencyUnavailableException` (a 503 with a Retry-After).
 * Either way it logs, annotates the active span, and dispatches a `DependencyDegraded`
 * event, so routing a read through here gives uniform observability the ad-hoc
 * catches never had.
 */
export type RunResilient = <T>(opts: ResilienceRunOptions<T>) => Promise<T>

/**
 * The default used when no `ResilienceService` is injected (bare unit specs, and any
 * call site that does not wire one). It reproduces the kernel policy semantics
 * locally WITHOUT importing the core exception: on `fail-open` it returns the
 * fallback, and on `fail-closed` it rethrows the original store error unchanged, so
 * the caller's own mapping (the rate limiter's `AIException('rate_limit_unavailable')`)
 * still fires exactly as it did before this seam existed. It emits no telemetry: a
 * unit context has no span or event bus to annotate, which is the whole reason the
 * real service is injected in production.
 */
export const runResilientPassthrough: RunResilient = async (opts) => {
  try {
    return await opts.run()
  } catch (error) {
    if (opts.policy === 'fail-open') return await opts.fallback()
    throw error
  }
}
