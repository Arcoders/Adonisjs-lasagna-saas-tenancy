import { getConfig } from '../../../config.js'
import { isDevOrTestNodeEnv } from '../../../utils/env.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const DEFAULT_WARN_SECONDS = 30
const DEFAULT_ERROR_SECONDS = 120
const PROBE_CONNECTION_PREFIX = '__doctor_replica_probe_'

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

/**
 * Measures streaming replication lag against each configured PostgreSQL read replica.
 * All issues are PLATFORM-scoped (replication is infrastructure, not one tenant's
 * concern). Two precision refinements avoid the classic local false-503:
 *
 *   - A replica whose host:port equals the primary's is not a replica at all — it is
 *     the common single-Postgres dev setup where the "replica" host falls back to the
 *     primary. It is reported as `replica_points_at_primary` and the probe is skipped;
 *     severity is `info` in dev/test and `warn` in production (a real prod
 *     misconfiguration worth surfacing, but never a boot-blocking error).
 *   - A distinct host that is NOT in recovery (a genuine misconfiguration) is `error`
 *     in production (fails the report → 503) and only `warn` in dev/test.
 */
const replicaLagCheck: DoctorCheck = {
  name: 'replica_lag',
  description:
    'Measures streaming replication lag against each configured PostgreSQL read replica.',

  async run(_ctx): Promise<DiagnosisIssue[]> {
    const cfg = getConfig()
    const replicas = cfg.tenantReadReplicas
    if (!replicas || replicas.hosts.length === 0) {
      // No replicas configured, nothing to check; not an issue.
      return []
    }

    const db = await lazyDb()
    if (!db) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          scope: 'platform',
          message: '@adonisjs/lucid is not available; cannot probe replicas',
        },
      ]
    }

    const warnSec = cfg.doctor?.replicaLagWarnSeconds ?? DEFAULT_WARN_SECONDS
    const errorSec = cfg.doctor?.replicaLagErrorSeconds ?? DEFAULT_ERROR_SECONDS
    const devOrTest = isDevOrTestNodeEnv()

    // Borrow the central connection config as a baseline so the probe inherits
    // SSL/charset/etc. from whatever the operator already configured.
    const centralName = cfg.centralConnectionName
    const centralRaw =
      (db.manager as any).get?.(centralName)?.config ??
      (db as any).getRawConnection?.(centralName)?.config
    const baseConnection: any = centralRaw?.connection ?? {}
    const primaryHost = baseConnection.host
    const primaryPort = baseConnection.port ?? 5432

    const issues: DiagnosisIssue[] = []

    for (let idx = 0; idx < replicas.hosts.length; idx++) {
      const host = replicas.hosts[idx]!
      const probeName = `${PROBE_CONNECTION_PREFIX}${idx}`
      const effectivePort = host.port ?? baseConnection.port ?? 5432
      const label = host.name ?? `${host.host}:${effectivePort}`

      // A "replica" pointed at the primary host:port is the single-Postgres dev
      // fallback, not a real replica. Report it and skip the probe (probing it would
      // find pg_is_in_recovery()=false and raise a spurious not-in-recovery error).
      if (host.host === primaryHost && effectivePort === primaryPort) {
        issues.push({
          code: 'replica_points_at_primary',
          severity: devOrTest ? 'info' : 'warn',
          scope: 'platform',
          message: `Configured replica "${label}" points at the primary host:port — not a real replica${
            devOrTest ? ' (expected in a single-Postgres dev setup)' : ''
          }`,
          meta: { host: label },
        })
        continue
      }

      try {
        if (!db.manager.has(probeName)) {
          db.manager.add(probeName, {
            client: 'pg',
            connection: {
              ...baseConnection,
              host: host.host,
              port: host.port ?? baseConnection.port,
              user: host.user ?? baseConnection.user,
              password: host.password ?? baseConnection.password,
            },
          })
        }

        const conn = db.connection(probeName)
        const result = await conn.rawQuery(
          // CASE handles a primary that has never seen a replay (returns NULL).
          // We cap NULL to 0 so we can tell "primary mistakenly registered" apart
          // from "real lag", but still emit a separate signal below.
          `SELECT
             pg_is_in_recovery() AS is_replica,
             COALESCE(EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp())), 0)::float AS lag_seconds`
        )
        const row: any = (result.rows ?? result)[0] ?? {}
        const isReplica = row.is_replica === true || row.is_replica === 't'
        const lag = Number(row.lag_seconds ?? 0)

        if (!isReplica) {
          // A distinct host that is not in recovery is a genuine misconfiguration:
          // error in production (fails the report → 503), warn in dev/test.
          issues.push({
            code: 'replica_not_in_recovery',
            severity: devOrTest ? 'warn' : 'error',
            scope: 'platform',
            message: `Configured replica "${label}" is NOT in recovery mode (likely a primary)`,
            meta: { host: label },
          })
          continue
        }

        if (lag >= errorSec) {
          issues.push({
            code: 'replica_lag_critical',
            severity: 'error',
            scope: 'platform',
            message: `Replica "${label}" lag ${lag.toFixed(1)}s exceeds error threshold ${errorSec}s`,
            meta: { host: label, lagSeconds: lag, threshold: errorSec },
          })
        } else if (lag >= warnSec) {
          issues.push({
            code: 'replica_lag_high',
            severity: 'warn',
            scope: 'platform',
            message: `Replica "${label}" lag ${lag.toFixed(1)}s exceeds warn threshold ${warnSec}s`,
            meta: { host: label, lagSeconds: lag, threshold: warnSec },
          })
        }
      } catch (error: any) {
        // We deliberately drop the raw error message. pg-driver errors
        // can include credentials (`password=…`, full DSN) and we don't
        // want those landing in `--json` doctor output, log shippers, or
        // the /admin/multitenancy/health/report response.
        const reasonCode =
          typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
            ? error.code
            : 'unknown'
        issues.push({
          code: 'replica_unreachable',
          severity: 'error',
          scope: 'platform',
          message: `Could not probe replica "${label}" (pg code: ${reasonCode})`,
          meta: { host: label, pgCode: reasonCode },
        })
      } finally {
        // Close the probe connection so we don't leak idle sockets between runs.
        try {
          if (db.manager.has(probeName)) {
            await db.manager.close(probeName)
            db.manager.release(probeName)
          }
        } catch {
          /* best-effort cleanup */
        }
      }
    }

    return issues
  },
}

export default replicaLagCheck
