import app from '@adonisjs/core/services/app'
import { getConfig } from '../config.js'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import type HealthService from './health_service.js'
import type { HealthCheckFn, CheckResult } from './health_service.js'

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

/**
 * Pings the backoffice connection with `SELECT 1`.
 */
export const backofficeDbCheck: HealthCheckFn = async (): Promise<CheckResult> => {
  const db = await lazyDb()
  if (!db) return { status: 'fail', durationMs: 0, message: '@adonisjs/lucid not available' }
  try {
    await db.connection(getConfig().backofficeConnectionName).rawQuery('SELECT 1')
    return { status: 'pass', durationMs: 0 }
  } catch (error: any) {
    return { status: 'fail', durationMs: 0, message: error?.message ?? 'query failed' }
  }
}

/**
 * Pings the default Redis connection (used by queues, metrics, cache).
 */
export const redisCheck: HealthCheckFn = async (): Promise<CheckResult> => {
  const redis = await lazyRedis()
  if (!redis) return { status: 'fail', durationMs: 0, message: '@adonisjs/redis not available' }
  try {
    const reply = await redis.ping()
    return { status: reply === 'PONG' ? 'pass' : 'fail', durationMs: 0, meta: { reply } }
  } catch (error: any) {
    return { status: 'fail', durationMs: 0, message: error?.message ?? 'ping failed' }
  }
}

/**
 * Reports a `pass` only when no circuits are OPEN. The provider can be
 * sync or async; useful for resolving the service from the container.
 */
/**
 * Registers the package's default check set on the given service:
 * backoffice_db (critical), redis (critical) and circuit_breakers
 * (non-critical). backoffice_db and redis are critical because a pod that
 * cannot reach either one cannot serve a single tenant request, so a failure
 * must pull it from rotation (503) even while the other checks pass. One
 * tenant's open circuit must not unready the whole pod, hence circuit_breakers
 * stays non-critical.
 *
 * The provider calls this once in `boot()`. It skips any name that is already
 * registered, and since host providers boot after this package's, a host can
 * override a default with `addCheck` (same name replaces) or drop it with
 * `removeCheck` from its own `boot()` — the change sticks, nothing re-registers
 * behind its back.
 */
export function registerDefaultChecks(svc: HealthService): HealthService {
  if (!svc.hasCheck('backoffice_db')) {
    svc.addCheck('backoffice_db', backofficeDbCheck, { critical: true })
  }
  if (!svc.hasCheck('redis')) svc.addCheck('redis', redisCheck, { critical: true })
  if (!svc.hasCheck('circuit_breakers')) {
    svc.addCheck(
      'circuit_breakers',
      makeCircuitBreakerCheck(async () => {
        try {
          const cb = await app.container.make(CircuitBreakerService)
          return cb.getAllMetrics()
        } catch {
          return {}
        }
      })
    )
  }
  return svc
}

export function makeCircuitBreakerCheck(
  circuitMetrics: () =>
    | Record<string, { state: string }>
    | Promise<Record<string, { state: string }>>
): HealthCheckFn {
  return async (): Promise<CheckResult> => {
    const metrics = await circuitMetrics()
    const open = Object.entries(metrics).filter(([, m]) => m.state === 'OPEN')
    if (open.length === 0) {
      return { status: 'pass', durationMs: 0, meta: { circuits: Object.keys(metrics).length } }
    }
    return {
      status: 'fail',
      durationMs: 0,
      message: `${open.length} circuit(s) OPEN`,
      meta: { open: open.map(([id]) => id) },
    }
  }
}
