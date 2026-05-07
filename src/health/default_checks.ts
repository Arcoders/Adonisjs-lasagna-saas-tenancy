import { getConfig } from '../config.js'
import type { HealthCheckFn, CheckResult } from './health_service.js'

const lazyDb = () =>
  import('@adonisjs/lucid/services/db')
    .then((m) => m.default)
    .catch(() => null)

const lazyRedis = () =>
  import('@adonisjs/redis/services/main')
    .then((m) => m.default)
    .catch(() => null)

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
