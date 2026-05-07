import { getConfig } from '../../../config.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const DEFAULT_WARN_RATIO = 0.9

const lazyDb = () =>
  import('@adonisjs/lucid/services/db')
    .then((m) => m.default)
    .catch(() => null)

const connectionPoolCheck: DoctorCheck = {
  name: 'connection_pool',
  description:
    'Reports per-connection pool saturation (numUsed/max) and pending acquire queues across tenant Lucid connections.',

  async run(_ctx): Promise<DiagnosisIssue[]> {
    const db = await lazyDb()
    if (!db) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          message: '@adonisjs/lucid is not available; cannot inspect pools',
        },
      ]
    }

    const cfg = getConfig()
    const tenantPrefix = cfg.tenantConnectionNamePrefix
    const warnRatio = cfg.doctor?.poolSaturationWarnRatio ?? DEFAULT_WARN_RATIO
    const issues: DiagnosisIssue[] = []

    const connections = db.manager.connections
    if (!connections || typeof connections.entries !== 'function') {
      return []
    }

    for (const [name, node] of connections) {
      // We focus on tenant connections + the central one. Probe connections
      // from other doctor checks (`__doctor_*`) are skipped.
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

      // Tenant id (when applicable) for prettier messages and tenantId field.
      // We only set it if the suffix really looks like a UUID — defense
      // against a connection name that happens to share the prefix but
      // isn't actually a tenant connection (orphan, custom adapter, etc.).
      const candidate = name.startsWith(tenantPrefix)
        ? name.slice(tenantPrefix.length)
        : undefined
      const tenantId =
        candidate &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)
          ? candidate
          : undefined

      if (max > 0 && numUsed / max >= warnRatio) {
        issues.push({
          code: 'pool_near_saturation',
          severity: numUsed >= max ? 'error' : 'warn',
          message: `Pool "${name}" is ${Math.round((numUsed / max) * 100)}% used (${numUsed}/${max})`,
          tenantId,
          meta: { connection: name, numUsed, numFree, max, ratio: numUsed / max },
        })
      }

      if (numPending > 0) {
        issues.push({
          code: 'pool_pending_acquires',
          severity: 'warn',
          message: `Pool "${name}" has ${numPending} pending acquire(s); workers are waiting for a connection`,
          tenantId,
          meta: { connection: name, numUsed, numFree, max, numPending },
        })
      }
    }

    return issues
  },
}

export default connectionPoolCheck
