import { trace } from '@opentelemetry/api'
import { getConfig } from '../config.js'
import DependencyUnavailableException from '../exceptions/dependency_unavailable_exception.js'
import type { FailurePolicy } from '../types/config.js'

const lazyLogger = () =>
  import('@adonisjs/core/services/logger')
    .then((m) => m.default)
    .catch(() => null)

export interface ResilienceRunOptions<T> {
  /** Logical dependency name, like `'redis'`, `'postgres'` or `'stripe'`. */
  dependency: string
  /** Operation label for telemetry, e.g. `'quota.consume'`. */
  operation: string
  /** What to do when `run()` throws. */
  policy: FailurePolicy
  tenantId?: string
  /** Value returned when `policy` is `'fail-open'` and `run()` throws. */
  fallback: () => T | Promise<T>
  /** The dependency call. Only its infrastructure failures should reach here.
   *  Keep business or domain throws (like QuotaExceeded) outside `run`. */
  run: () => Promise<T>
}

/**
 * One typed, observable contract for what happens when a backing dependency
 * (Redis, Postgres or Stripe) is unavailable. It replaces the ad-hoc handling
 * that used to live in each subsystem, where one place silently returned `0`,
 * another threw a raw driver error, and a third carried its own flag.
 *
 * With `fail-open` it swallows the failure and returns `fallback()`, favouring
 * availability. With `fail-closed` it throws `DependencyUnavailableException`,
 * which renders a 503 with a Retry-After.
 *
 * Either way, when `config.resilience.observe` isn't `false` it logs, annotates
 * the active OpenTelemetry span, and emits a `DependencyDegraded` event so ops
 * can alarm on a backing-service outage.
 *
 * `MultitenancyProvider` registers it as a container singleton, but it's
 * stateless, so a plain `new ResilienceService()` works just as well.
 */
export default class ResilienceService {
  async run<T>(opts: ResilienceRunOptions<T>): Promise<T> {
    try {
      return await opts.run()
    } catch (err) {
      await this.#onDegraded(opts, err)
      if (opts.policy === 'fail-open') {
        return await opts.fallback()
      }
      throw new DependencyUnavailableException({
        dependency: opts.dependency,
        operation: opts.operation,
        tenantId: opts.tenantId,
      })
    }
  }

  async #onDegraded<T>(opts: ResilienceRunOptions<T>, err: unknown): Promise<void> {
    let observe = true
    try {
      observe = getConfig().resilience?.observe ?? true
    } catch {
      // Config isn't booted (for example in a unit context), so still log it.
    }
    if (!observe) return

    const errorCode =
      (err as { code?: string })?.code ?? (err as Error)?.name ?? 'unknown'

    // Annotate the active span (if any) so traces show the degradation.
    trace.getActiveSpan()?.addEvent('dependency.degraded', {
      'dependency.name': opts.dependency,
      'dependency.operation': opts.operation,
      'dependency.policy': opts.policy,
    })

    const logger = await lazyLogger()
    logger?.warn(
      {
        dependency: opts.dependency,
        operation: opts.operation,
        tenantId: opts.tenantId,
        policy: opts.policy,
        err: (err as Error)?.message ?? String(err),
      },
      'resilience: dependency degraded'
    )

    // Event emission is best-effort. Never let observability break the call.
    try {
      const { default: DependencyDegraded } = await import('../events/dependency_degraded.js')
      await DependencyDegraded.dispatch({
        dependency: opts.dependency,
        operation: opts.operation,
        tenantId: opts.tenantId ?? null,
        policy: opts.policy,
        errorCode,
      })
    } catch {
      // Emitter isn't available (unbooted app); the log above still fired.
    }
  }
}
