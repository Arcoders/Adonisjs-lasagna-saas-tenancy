import { getConfig } from '../../../config.js'
import { mapDataAsOf, isStale, staleDays } from '../../../freshness.js'
import { DateTime } from 'luxon'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const DEFAULT_THRESHOLD_DAYS = 2
const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

/**
 * Opt-in check: warns when the backoffice `tenant_metrics` table has not been
 * flushed recently, i.e. the cross-tenant reports are running on stale data
 * (usually a `tenant:metrics:flush` cron that stopped). Deliberately NOT in
 * `builtInChecks`: a fresh install / test DB legitimately has no metrics yet and
 * would warn forever. Register it explicitly in your provider when you run the
 * metrics pipeline.
 */
const metricsFreshnessCheck: DoctorCheck = {
  name: 'metrics_freshness',
  description: 'Warns when tenant_metrics has not been flushed within the freshness threshold.',

  async run(_ctx): Promise<DiagnosisIssue[]> {
    const db = await lazyDb()
    if (!db) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          message: '@adonisjs/lucid is not available',
        },
      ]
    }
    const cfg = getConfig()
    const threshold = DEFAULT_THRESHOLD_DAYS

    let conn
    try {
      conn = db.connection(cfg.backofficeConnectionName)
    } catch {
      return []
    }

    try {
      // `tenant_metrics` is a fixed core backoffice table; the schema is config-driven.
      const result = await conn.rawQuery(`SELECT MAX(period)::text AS as_of FROM ??.??`, [
        cfg.backofficeSchemaName,
        'tenant_metrics',
      ])
      const asOf = mapDataAsOf((result.rows as Array<{ as_of: unknown }>)?.[0])
      const now = DateTime.utc().toFormat('yyyy-MM-dd')
      if (!isStale(asOf, now, threshold)) return []

      const aged = staleDays(asOf, now)
      return [
        {
          code: asOf ? 'metrics_stale' : 'metrics_absent',
          severity: 'warn',
          message: asOf
            ? `tenant_metrics last flushed ${asOf} (${aged}d ago; threshold ${threshold}d) — is tenant:metrics:flush running?`
            : 'tenant_metrics is empty — has tenant:metrics:flush ever run?',
          meta: { asOf, thresholdDays: threshold, staleDays: aged },
        },
      ]
    } catch (error: any) {
      return [
        {
          code: 'metrics_freshness_unreadable',
          severity: 'info',
          message: `Could not read tenant_metrics: ${error?.message ?? 'unknown'}`,
        },
      ]
    }
  },
}

export default metricsFreshnessCheck
