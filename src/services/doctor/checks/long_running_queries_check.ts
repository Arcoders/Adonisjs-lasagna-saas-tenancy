import { getConfig } from '../../../config.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const DEFAULT_WARN_SECONDS = 30
const DEFAULT_ERROR_SECONDS = 120

const lazyDb = () =>
  import('@adonisjs/lucid/services/db')
    .then((m) => m.default)
    .catch(() => null)

const longRunningQueriesCheck: DoctorCheck = {
  name: 'long_running_queries',
  description:
    'Surfaces PostgreSQL backends with `state=active` whose query duration exceeds the configured threshold.',

  async run(_ctx): Promise<DiagnosisIssue[]> {
    const db = await lazyDb()
    if (!db) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          message: '@adonisjs/lucid is not available; cannot inspect activity',
        },
      ]
    }

    const cfg = getConfig()
    const warnSec = cfg.doctor?.longQueryWarnSeconds ?? DEFAULT_WARN_SECONDS
    const errorSec = cfg.doctor?.longQueryErrorSeconds ?? DEFAULT_ERROR_SECONDS

    let conn
    try {
      conn = db.connection(cfg.centralConnectionName)
    } catch {
      return []
    }

    const issues: DiagnosisIssue[] = []
    try {
      // We exclude our own backend (the one running this query) and any
      // non-client backend (autovacuum/walwriter/etc.). `query` is truncated
      // server-side via left() to avoid blowing up `meta` payloads.
      const result = await conn.rawQuery(
        `SELECT
           pid,
           datname,
           usename,
           application_name,
           state,
           EXTRACT(EPOCH FROM (NOW() - query_start))::float AS duration_seconds,
           left(query, 500) AS query
         FROM pg_stat_activity
         WHERE state = 'active'
           AND pid <> pg_backend_pid()
           AND backend_type = 'client backend'
           AND query_start IS NOT NULL
           AND NOW() - query_start > make_interval(secs => ?)
         ORDER BY query_start ASC
         LIMIT 50`,
        [warnSec]
      )
      const rows: any[] = result.rows ?? result ?? []

      for (const row of rows) {
        const duration = Number(row.duration_seconds ?? 0)
        const severity: 'warn' | 'error' = duration >= errorSec ? 'error' : 'warn'
        issues.push({
          code: severity === 'error' ? 'long_running_query_critical' : 'long_running_query',
          severity,
          message: `Query on db "${row.datname}" running for ${duration.toFixed(1)}s (pid ${row.pid})`,
          meta: {
            pid: row.pid,
            database: row.datname,
            user: row.usename,
            applicationName: row.application_name,
            durationSeconds: duration,
            query: row.query,
          },
        })
      }
    } catch (error: any) {
      issues.push({
        code: 'pg_stat_activity_unreadable',
        severity: 'info',
        message: `Could not read pg_stat_activity: ${error?.message ?? 'unknown'}`,
      })
    }

    return issues
  },
}

export default longRunningQueriesCheck
