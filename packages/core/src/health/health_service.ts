/**
 * The binary outcome of a single health check, either `'pass'` or `'fail'`. It is
 * the status field carried by `CheckResult` and the public `PublicCheckResult`,
 * and `readiness()` aggregates these per-check values into the report's overall
 * `'ok' | 'degraded' | 'fail'` status. A check that throws or times out is
 * recorded as `'fail'`.
 */
export type CheckStatus = 'pass' | 'fail'

/**
 * Describes the outcome of running a single registered health check. It carries
 * a pass or fail `status`, the wall-clock `durationMs` the check took, an optional
 * human-readable `message`, optional structured `meta`, and a `critical` flag set
 * when the check was registered with `critical: true`. Health check functions
 * resolve with this shape, and the readiness report aggregates one per check.
 */
export interface CheckResult {
  status: CheckStatus
  durationMs: number
  message?: string
  meta?: Record<string, unknown>
  /** Present (and `true`) when the check was registered with `critical: true`. */
  critical?: boolean
}

/**
 * Signature for a custom readiness check registered with `HealthService.addCheck`. The
 * function takes no arguments and returns a `CheckResult` either synchronously or as a
 * promise, reporting `pass` or `fail` along with optional timing, message, and metadata.
 * The service runs it under a timeout, and any throw or rejection is recorded as a failure.
 */
export type HealthCheckFn = () => Promise<CheckResult> | CheckResult

/**
 * Options accepted by `HealthService.addCheck` when registering a custom readiness
 * check. It carries a single optional `critical` flag: when set, a failure of that
 * one check forces the aggregate readiness status to `fail` (and a 503 from
 * `/readyz`) even if every other registered check passes, marking a dependency the
 * process cannot serve any request without.
 */
export interface AddCheckOptions {
  /**
   * A failed critical check forces the aggregate readiness status to `fail`
   * (HTTP 503 from `/readyz`) even when every other check passes. Use it for
   * dependencies without which the pod cannot serve a single request.
   */
  critical?: boolean
}

/**
 * Full readiness result returned by `HealthService.readiness()`, aggregating
 * every registered check into one snapshot. It carries the overall `status`
 * (`ok` when all checks pass, `degraded` when only non-critical checks fail,
 * `fail` when all fail or any critical check fails), the process `uptime` in
 * seconds, and a `checks` map of each check name to its detailed `CheckResult`.
 * This is the authenticated, internals-bearing report that `toPublicHealthReport`
 * projects down before exposure on unauthenticated probes.
 */
export interface HealthReport {
  status: 'ok' | 'degraded' | 'fail'
  uptime: number
  checks: Record<string, CheckResult>
}

/**
 * The redacted shape of a single health check as exposed on the unauthenticated
 * `/readyz` and `/healthz` probe surface. It carries only the binary `status`
 * (`pass` or `fail`) and an optional non-identifying `critical` flag, deliberately
 * omitting the `message`, `meta`, and `durationMs` fields of the full `CheckResult`
 * so an anonymous caller cannot read raw error strings, tenant ids, or internal
 * timing. The `toPublicHealthReport` projection produces these entries.
 */
export interface PublicCheckResult {
  status: CheckStatus
  /** Present (and `true`) only when the check is critical (non-identifying). */
  critical?: boolean
}

/**
 * Redaction-safe shape of a health report that is returned by `toPublicHealthReport`
 * and exposed on the unauthenticated `/readyz` and `/healthz` probes. It keeps only
 * the aggregate `status`, the process `uptime`, and a map of per-check results reduced
 * to a status and criticality flag, deliberately dropping the per-check `meta`,
 * `message`, and `durationMs` fields so anonymous callers cannot enumerate tenants or
 * read internal error and timing details.
 */
export interface PublicHealthReport {
  status: HealthReport['status']
  uptime: number
  checks: Record<string, PublicCheckResult>
}

/**
 * Project a full {@link HealthReport} down to the binary up/down signal that is
 * safe to expose on the UNAUTHENTICATED `/readyz` and `/healthz` probes.
 *
 * The full report's per-check `meta` can carry OPEN-circuit tenant ids (the same
 * ids `/metrics` is gated to hide), `message` carries raw DB/Redis error strings,
 * and `durationMs` is an internal timing signal. None of that belongs on an
 * anonymous probe, so this keeps only the aggregate status, the uptime, and each
 * check's status and criticality. That is all a Kubernetes probe needs, and it
 * gives an attacker nothing to enumerate tenants or read internals with. The
 * detailed report stays behind auth (the admin `/health/report` Doctor surface).
 */
export function toPublicHealthReport(report: HealthReport): PublicHealthReport {
  const checks: Record<string, PublicCheckResult> = {}
  for (const [name, result] of Object.entries(report.checks)) {
    checks[name] = result.critical
      ? { status: result.status, critical: true }
      : { status: result.status }
  }
  return { status: report.status, uptime: report.uptime, checks }
}

const DEFAULT_TIMEOUT_MS = 2000

interface RegisteredCheck {
  fn: HealthCheckFn
  critical: boolean
}

/**
 * A registry-backed health probe service that holds a map of named readiness
 * checks and aggregates them into liveness and readiness reports. It exposes
 * `addCheck`, `removeCheck`, `hasCheck`, and `isCritical` to manage checks,
 * `liveness()` for a pure process-alive signal that never touches external
 * dependencies, and `readiness()` which runs every registered check with a
 * per-check timeout and folds the results into an `ok`, `degraded`, or `fail`
 * status. A failed check marked `critical` forces the aggregate to `fail`,
 * while non-critical failures only degrade it, and rejecting or timed-out
 * checks are treated as failures.
 */
export default class HealthService {
  readonly #startedAt = Date.now()
  readonly #checks = new Map<string, RegisteredCheck>()

  /**
   * Register a custom readiness check. The function should resolve with a
   * `CheckResult`. Throwing or rejecting is treated as `fail`. Pass
   * `{ critical: true }` to make a failure of this check alone unready the
   * process regardless of the other checks.
   */
  addCheck(name: string, check: HealthCheckFn, options: AddCheckOptions = {}): this {
    this.#checks.set(name, { fn: check, critical: options.critical === true })
    return this
  }

  removeCheck(name: string): this {
    this.#checks.delete(name)
    return this
  }

  hasCheck(name: string): boolean {
    return this.#checks.has(name)
  }

  /** Whether the named check is registered with `critical: true`. */
  isCritical(name: string): boolean {
    return this.#checks.get(name)?.critical === true
  }

  /**
   * Liveness — process is alive. Never depends on external services.
   */
  liveness(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: this.#uptime() }
  }

  /**
   * Readiness — runs every registered check. `ok` if all pass, `fail` if all
   * fail OR any critical check fails, `degraded` if only non-critical checks
   * fail.
   */
  async readiness(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<HealthReport> {
    const entries = [...this.#checks.entries()]
    const results: Record<string, CheckResult> = {}

    await Promise.all(
      entries.map(async ([name, { fn, critical }]) => {
        const result = await this.#runWithTimeout(fn, timeoutMs)
        results[name] = critical ? { ...result, critical: true } : result
      })
    )

    const total = entries.length
    const passed = Object.values(results).filter((r) => r.status === 'pass').length
    const criticalFailed = entries.some(
      ([name, { critical }]) => critical && results[name]!.status === 'fail'
    )
    const status: HealthReport['status'] = criticalFailed
      ? 'fail'
      : total === 0 || passed === total
        ? 'ok'
        : passed === 0
          ? 'fail'
          : 'degraded'

    return { status, uptime: this.#uptime(), checks: results }
  }

  async #runWithTimeout(fn: HealthCheckFn, timeoutMs: number): Promise<CheckResult> {
    const start = Date.now()
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => fn()),
        new Promise<CheckResult>((_, reject) =>
          setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ])
      const durationMs = Date.now() - start
      return { ...result, durationMs }
    } catch (error: any) {
      return {
        status: 'fail',
        durationMs: Date.now() - start,
        message: error?.message ?? 'check threw',
      }
    }
  }

  #uptime(): number {
    return Math.floor((Date.now() - this.#startedAt) / 1000)
  }
}
