import { getConfig } from '../../../config.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const DEFAULT_WARN_RATIO = 0.9

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Live saturation stats for one Lucid pool the package cares about. */
export interface TenantPoolStat {
  connection: string
  /** Tenant id when the connection name carries a UUID suffix; else undefined. */
  tenantId?: string
  numUsed: number
  numFree: number
  numPending: number
  max: number
  /** numUsed / max, or 0 when max is unknown. */
  ratio: number
}

/**
 * The single source for tenant-pool saturation. Iterates the open tenant
 * connections plus the central and backoffice ones (skipping internal
 * `__doctor_` probes) and reads numUsed/numFree/pending/max from each pool. The
 * doctor check (warnings/errors), the readiness gate, and the Prometheus gauge
 * all derive from this, so they can never disagree about how saturated a pool is.
 * Returns null when Lucid cannot be loaded.
 */
export async function collectTenantPoolStats(): Promise<TenantPoolStat[] | null> {
  const db = await lazyDb()
  if (!db) return null

  const cfg = getConfig()
  const tenantPrefix = cfg.tenantConnectionNamePrefix
  const connections = db.manager.connections
  if (!connections || typeof connections.entries !== 'function') return []

  const stats: TenantPoolStat[] = []
  for (const [name, node] of connections) {
    if (name.startsWith('__doctor_')) continue
    if (
      !name.startsWith(tenantPrefix) &&
      name !== cfg.centralConnectionName &&
      name !== cfg.backofficeConnectionName
    ) {
      continue
    }
    if (node.state !== 'open' || !node.connection) continue

    const pool: any = node.connection.pool
    if (!pool || typeof pool.numUsed !== 'function') continue

    const numUsed = Number(pool.numUsed?.() ?? 0)
    const numFree = Number(pool.numFree?.() ?? 0)
    const numPending = Number(pool.numPendingAcquires?.() ?? 0)
    const max = Number(pool.max ?? numUsed + numFree)

    // Only treat the suffix as a tenant id when it really is a UUID — defense
    // against a connection name that shares the prefix but isn't a tenant pool.
    const candidate = name.startsWith(tenantPrefix) ? name.slice(tenantPrefix.length) : undefined
    const tenantId = candidate && UUID_RE.test(candidate) ? candidate : undefined

    stats.push({
      connection: name,
      tenantId,
      numUsed,
      numFree,
      numPending,
      max,
      ratio: max > 0 ? numUsed / max : 0,
    })
  }
  return stats
}

/**
 * A doctor check that reports per-connection pool saturation (numUsed/max) and
 * pending acquire queues across tenant Lucid connections, derived from
 * {@link collectTenantPoolStats}. Emits a `pool_near_saturation` issue (warn, or
 * error when fully used) once usage reaches the configured warn ratio, and a
 * `pool_pending_acquires` issue when workers are queued. Returns a
 * `lucid_unavailable` error issue if Lucid cannot be loaded.
 */
const connectionPoolCheck: DoctorCheck = {
  name: 'connection_pool',
  description:
    'Reports per-connection pool saturation (numUsed/max) and pending acquire queues across tenant Lucid connections.',

  async run(_ctx): Promise<DiagnosisIssue[]> {
    const stats = await collectTenantPoolStats()
    if (stats === null) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          message: '@adonisjs/lucid is not available; cannot inspect pools',
        },
      ]
    }

    const warnRatio = getConfig().doctor?.poolSaturationWarnRatio ?? DEFAULT_WARN_RATIO
    const issues: DiagnosisIssue[] = []

    for (const s of stats) {
      if (s.max > 0 && s.ratio >= warnRatio) {
        issues.push({
          code: 'pool_near_saturation',
          severity: s.numUsed >= s.max ? 'error' : 'warn',
          message: `Pool "${s.connection}" is ${Math.round(s.ratio * 100)}% used (${s.numUsed}/${s.max})`,
          tenantId: s.tenantId,
          meta: {
            connection: s.connection,
            numUsed: s.numUsed,
            numFree: s.numFree,
            max: s.max,
            ratio: s.ratio,
          },
        })
      }
      if (s.numPending > 0) {
        issues.push({
          code: 'pool_pending_acquires',
          severity: 'warn',
          message: `Pool "${s.connection}" has ${s.numPending} pending acquire(s); workers are waiting for a connection`,
          tenantId: s.tenantId,
          meta: {
            connection: s.connection,
            numUsed: s.numUsed,
            numFree: s.numFree,
            max: s.max,
            numPending: s.numPending,
          },
        })
      }
    }

    return issues
  },
}

export default connectionPoolCheck
