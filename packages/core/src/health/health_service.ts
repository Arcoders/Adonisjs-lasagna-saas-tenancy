export type CheckStatus = 'pass' | 'fail'

export interface CheckResult {
  status: CheckStatus
  durationMs: number
  message?: string
  meta?: Record<string, unknown>
}

export type HealthCheckFn = () => Promise<CheckResult> | CheckResult

export interface HealthReport {
  status: 'ok' | 'degraded' | 'fail'
  uptime: number
  checks: Record<string, CheckResult>
}

const DEFAULT_TIMEOUT_MS = 2000

export default class HealthService {
  readonly #startedAt = Date.now()
  readonly #checks = new Map<string, HealthCheckFn>()

  /**
   * Register a custom readiness check. The function should resolve with a
   * `CheckResult`. Throwing or rejecting is treated as `fail`.
   */
  addCheck(name: string, check: HealthCheckFn): this {
    this.#checks.set(name, check)
    return this
  }

  removeCheck(name: string): this {
    this.#checks.delete(name)
    return this
  }

  hasCheck(name: string): boolean {
    return this.#checks.has(name)
  }

  /**
   * Liveness — process is alive. Never depends on external services.
   */
  liveness(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: this.#uptime() }
  }

  /**
   * Readiness — runs every registered check. `ok` if all pass, `fail` if all
   * fail, `degraded` if some fail.
   */
  async readiness(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<HealthReport> {
    const entries = [...this.#checks.entries()]
    const results: Record<string, CheckResult> = {}

    await Promise.all(
      entries.map(async ([name, fn]) => {
        results[name] = await this.#runWithTimeout(fn, timeoutMs)
      })
    )

    const total = entries.length
    const passed = Object.values(results).filter((r) => r.status === 'pass').length
    const status: HealthReport['status'] =
      total === 0 || passed === total ? 'ok' : passed === 0 ? 'fail' : 'degraded'

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
