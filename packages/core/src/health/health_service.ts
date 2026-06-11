export type CheckStatus = 'pass' | 'fail'

export interface CheckResult {
  status: CheckStatus
  durationMs: number
  message?: string
  meta?: Record<string, unknown>
  /** Present (and `true`) when the check was registered with `critical: true`. */
  critical?: boolean
}

export type HealthCheckFn = () => Promise<CheckResult> | CheckResult

export interface AddCheckOptions {
  /**
   * A failed critical check forces the aggregate readiness status to `fail`
   * (HTTP 503 from `/readyz`) even when every other check passes. Use it for
   * dependencies without which the pod cannot serve a single request.
   */
  critical?: boolean
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'fail'
  uptime: number
  checks: Record<string, CheckResult>
}

const DEFAULT_TIMEOUT_MS = 2000

interface RegisteredCheck {
  fn: HealthCheckFn
  critical: boolean
}

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
      ([name, { critical }]) => critical && results[name].status === 'fail'
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
