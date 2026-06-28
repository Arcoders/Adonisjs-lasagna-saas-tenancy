import { createHash } from 'node:crypto'
import { getConfig } from '../../../config.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const DEFAULT_WARN_SECONDS = 30
const DEFAULT_ERROR_SECONDS = 120

/**
 * Non-reversible 12-hex-char fingerprint of a SQL statement, so operators can
 * tell two slow queries apart and correlate across probes WITHOUT the raw text
 * (which can carry another tenant's secrets/PII as literals) ever reaching the
 * HTTP-exposed `/health/report` meta.
 */
function fingerprintQuery(query: unknown): string | undefined {
  if (typeof query !== 'string' || query.length === 0) return undefined
  return createHash('sha256').update(query).digest('hex').slice(0, 12)
}

/** A `pg_stat_activity` row as selected by the check. */
export interface ActivityRow {
  pid: number | string
  datname: string
  usename: string
  application_name: string
  duration_seconds: number | string
  query: string
}

/**
 * Map one long-running backend to a diagnosis issue. Exported and pure so the
 * security-sensitive projection (raw SQL text never reaches meta unless opted
 * in) is unit-testable without a live database.
 */
export function buildLongQueryIssue(
  row: ActivityRow,
  errorSec: number,
  includeQueryText: boolean
): DiagnosisIssue {
  const duration = Number(row.duration_seconds ?? 0)
  const severity: 'warn' | 'error' = duration >= errorSec ? 'error' : 'warn'
  return {
    code: severity === 'error' ? 'long_running_query_critical' : 'long_running_query',
    severity,
    message: `Query on db "${row.datname}" running for ${duration.toFixed(1)}s (pid ${row.pid})`,
    meta: {
      pid: row.pid,
      database: row.datname,
      user: row.usename,
      applicationName: row.application_name,
      durationSeconds: duration,
      // Non-reversible by default; the raw statement (which can carry
      // cross-tenant secrets/PII as SQL literals) is included only behind the
      // explicit opt-in, never on the default HTTP-exposed report.
      queryFingerprint: fingerprintQuery(row.query),
      ...(includeQueryText ? { query: row.query } : {}),
    },
  }
}

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

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
    // Off by default: raw SQL text never reaches the HTTP-exposed report unless a
    // host deliberately opts in for trusted local CLI diagnosis.
    const includeQueryText = cfg.doctor?.includeQueryText === true

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
      // server-side via left() to avoid blowing up `meta` payloads; it is only
      // emitted into meta when `doctor.includeQueryText` is on (see below).
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
        issues.push(buildLongQueryIssue(row, errorSec, includeQueryText))
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
