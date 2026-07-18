import { useCallback, useEffect, useState } from 'react'
import { OperatorShell, Stat } from '../../components/shells'
import { api } from '../../lib/api'
import type { AdminTenant } from '../../types'

/* Platform health, from the admin satellite. `GET /admin/health/report` runs the
 * DoctorService (built-in checks + the app's `fleet_health` check) and answers
 * 200 when there are no errors, 503 otherwise — with the SAME body either way, so
 * this page reads it with a raw fetch rather than the throw-on-non-2xx helper.
 * Per-company queue depth comes from `GET /admin/tenants/:id/queue/stats`. */

type Severity = 'info' | 'warn' | 'error'
type Scope = 'platform' | 'tenant'
type Issue = { code: string; severity: Severity; scope?: Scope; message: string; fixable?: boolean }
type CheckReport = {
  check: string
  description: string
  durationMs: number
  issues: Issue[]
  error?: string
}
type RunStatus = 'ok' | 'degraded' | 'fail'
type Totals = {
  info: number
  warn: number
  error: number
  fixable: number
  platformError: number
  tenantError: number
}
type HealthReport = { reports: CheckReport[]; status: RunStatus; totals: Totals }

const EMPTY_TOTALS: Totals = {
  info: 0,
  warn: 0,
  error: 0,
  fixable: 0,
  platformError: 0,
  tenantError: 0,
}

type QueueStats = {
  tenantId: string
  queueName: string
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}
type QueueRow = { name: string; stats: QueueStats }

const SEVERITY_TONE: Record<Severity, string> = {
  info: 'badge--slate',
  warn: 'badge--amber',
  error: 'badge--red',
}

export default function Health() {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [queues, setQueues] = useState<QueueRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 200 or 503 — the doctor body is identical, so read it raw.
      const res = await fetch('/admin/health/report', {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      })
      setReport((await res.json()) as HealthReport)

      // Queue depth for each active company (best-effort: a company without a
      // provisioned queue just drops out).
      const tenants = await api
        .get<{ data: AdminTenant[] }>('/admin/tenants?includeDeleted=false')
        .catch(() => ({ data: [] }))
      const active = tenants.data.filter((t) => t.status === 'active')
      const rows = await Promise.all(
        active.map((t) =>
          api
            .get<{ data: QueueStats }>(`/admin/tenants/${t.id}/queue/stats`)
            .then((r) => ({ name: t.name, stats: r.data }))
            .catch(() => null)
        )
      )
      setQueues(rows.filter((r): r is QueueRow => r !== null))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load health')
      setReport({ reports: [], status: 'ok', totals: EMPTY_TOTALS })
      setQueues([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const totals = report?.totals ?? EMPTY_TOTALS
  // Tri-state verdict, mirroring the doctor: a platform error fails (Attention), a
  // lone tenant error only degrades (200), else Healthy. This is why one broken
  // company no longer paints the whole console red.
  const status: RunStatus = report?.status ?? 'ok'
  const verdict =
    status === 'fail'
      ? { label: 'Attention', tone: 'badge--red' }
      : status === 'degraded'
        ? { label: 'Degraded', tone: 'badge--amber' }
        : { label: 'Healthy', tone: 'badge--green' }

  return (
    <OperatorShell title="Health & doctor" activeHref="/health">
      <div className="page-head">
        <div>
          <h1>Health &amp; doctor</h1>
          <p>Platform-wide diagnostics across every company, plus per-company queue depth.</p>
        </div>
        <button className="btn btn--subtle btn--sm" onClick={load} disabled={loading}>
          {loading ? 'Running…' : 'Run doctor'}
        </button>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <Stat
          label="Overall"
          value={
            <span className={`badge ${verdict.tone}`}>
              <span className="dot" />
              {verdict.label}
            </span>
          }
          sub={`${report?.reports.length ?? 0} checks`}
        />
        <Stat
          label="Errors"
          value={totals.error}
          sub={
            totals.error > 0
              ? `${totals.platformError} platform · ${totals.tenantError} tenant`
              : totals.fixable
                ? `${totals.fixable} fixable`
                : 'none'
          }
        />
        <Stat label="Warnings" value={totals.warn} sub="advisory" />
        <Stat label="Info" value={totals.info} sub="notes" />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card__head">
          <div className="card__title">Diagnostic checks</div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Check</th>
                <th>Findings</th>
                <th style={{ textAlign: 'right' }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {report === null && (
                <tr>
                  <td colSpan={3} className="empty">
                    Running diagnostics…
                  </td>
                </tr>
              )}
              {report?.reports.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">
                    No checks reported.
                  </td>
                </tr>
              )}
              {report?.reports.map((r) => (
                <tr key={r.check}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.check}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {r.description}
                    </div>
                  </td>
                  <td>
                    {r.error ? (
                      <span className="badge badge--red">
                        <span className="dot" />
                        check threw: {r.error}
                      </span>
                    ) : r.issues.length === 0 ? (
                      <span className="badge badge--green">
                        <span className="dot" />
                        ok
                      </span>
                    ) : (
                      <div className="row row--wrap" style={{ gap: 6 }}>
                        {r.issues.map((iss, i) => (
                          <span
                            key={`${r.check}:${i}`}
                            className={`badge ${SEVERITY_TONE[iss.severity]}`}
                            title={iss.code}
                          >
                            <span className="dot" />
                            {iss.message}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="mono" style={{ textAlign: 'right', fontSize: 12.5 }}>
                    {r.durationMs} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div className="card__title">Queue depth by company</div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Waiting</th>
                <th>Active</th>
                <th>Completed</th>
                <th>Failed</th>
                <th>Delayed</th>
              </tr>
            </thead>
            <tbody>
              {queues === null && (
                <tr>
                  <td colSpan={6} className="empty">
                    Loading queues…
                  </td>
                </tr>
              )}
              {queues?.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No active queues.
                  </td>
                </tr>
              )}
              {queues?.map((q) => (
                <tr key={q.stats.tenantId}>
                  <td style={{ fontWeight: 600 }}>{q.name}</td>
                  <td>{q.stats.waiting}</td>
                  <td>{q.stats.active}</td>
                  <td>{q.stats.completed}</td>
                  <td>
                    {q.stats.failed > 0 ? (
                      <span className="badge badge--red">
                        <span className="dot" />
                        {q.stats.failed}
                      </span>
                    ) : (
                      0
                    )}
                  </td>
                  <td>{q.stats.delayed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </OperatorShell>
  )
}
