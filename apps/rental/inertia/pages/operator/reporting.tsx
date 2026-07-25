import { useCallback, useEffect, useMemo, useState } from 'react'
import { OperatorShell, Stat } from '../../components/shells'
import { api } from '../../lib/api'
import type { AdminTenant } from '../../types'

/* Cross-tenant reporting, read from the reporting satellite under
 * `/admin/reporting`. Two lenses: the traffic dashboard (requests / errors /
 * bandwidth aggregated from tenant_metrics by the trackMetrics middleware) and
 * the app's own `fleet_utilization` report extension (real domain data: fleet
 * size, active rentals and utilization per company). */

type Period = 'day' | 'week' | 'month'

type AggregateBucket = {
  period: string
  totalRequests: number
  totalErrors: number
  totalBandwidthBytes: number
  activeTenants: number
  errorRate: number
}
type TopTenant = {
  tenantId: string
  requests: number
  errors: number
  bandwidthBytes: number
  errorRate: number
}
type CustomMetric = { name: string; total: number }
type Dashboard = {
  aggregate: AggregateBucket[]
  topTenants: TopTenant[]
  customMetrics: CustomMetric[]
  dataAsOf: string | null
}
type FleetRow = { tenant: string; vehicles: number; activeRentals: number; utilization: number }

export default function Reporting() {
  const [period, setPeriod] = useState<Period>('day')
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [fleet, setFleet] = useState<FleetRow[] | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (p: Period) => {
    setError(null)
    try {
      const [dash, ext, tenants] = await Promise.all([
        api.get<{ data: Dashboard }>(`/admin/reporting/dashboard?period=${p}`),
        api
          .get<{
            data: { companies: FleetRow[] }
          }>('/admin/reporting/reports/extension/fleet_utilization')
          .catch(() => ({ data: { companies: [] } })),
        api
          .get<{ data: AdminTenant[] }>('/admin/tenants?includeDeleted=true')
          .catch(() => ({ data: [] })),
      ])
      setDashboard(dash.data)
      setFleet(ext.data.companies)
      const map: Record<string, string> = {}
      for (const t of tenants.data) map[t.id] = t.name
      setNames(map)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reporting')
      setDashboard({ aggregate: [], topTenants: [], customMetrics: [], dataAsOf: null })
      setFleet([])
    }
  }, [])

  useEffect(() => {
    load(period)
  }, [load, period])

  const totals = useMemo(() => {
    const buckets = dashboard?.aggregate ?? []
    const requests = buckets.reduce((a, b) => a + b.totalRequests, 0)
    const errors = buckets.reduce((a, b) => a + b.totalErrors, 0)
    const bandwidth = buckets.reduce((a, b) => a + b.totalBandwidthBytes, 0)
    const activeTenants = buckets.reduce((a, b) => Math.max(a, b.activeTenants), 0)
    return {
      requests,
      errors,
      bandwidth,
      activeTenants,
      errorRate: requests ? errors / requests : 0,
    }
  }, [dashboard])

  const nameOf = (id: string) => names[id] ?? `${id.slice(0, 8)}…`

  return (
    <OperatorShell title="Reporting" activeHref="/reporting">
      <div className="page-head">
        <div>
          <h1>Reporting</h1>
          <p>Cross-tenant traffic and fleet utilization across every company on the platform.</p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {(['day', 'week', 'month'] as Period[]).map((p) => (
            <button
              key={p}
              className={`btn btn--sm ${period === p ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setPeriod(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <Stat label="Requests" value={fmt(totals.requests)} sub={`per ${period}, all companies`} />
        <Stat
          label="Errors"
          value={fmt(totals.errors)}
          sub={`${(totals.errorRate * 100).toFixed(1)}% error rate`}
        />
        <Stat label="Active companies" value={totals.activeTenants} sub="with traffic" />
        <Stat
          label="Bandwidth"
          value={fmtBytes(totals.bandwidth)}
          sub={dashboard?.dataAsOf ? `as of ${dashboard.dataAsOf}` : 'metrics'}
        />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card__head">
          <div className="card__title">Fleet utilization</div>
          <span className="muted" style={{ fontSize: 12.5 }}>
            fleet_utilization report extension
          </span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Fleet</th>
                <th>On the road</th>
                <th style={{ width: '40%' }}>Utilization</th>
              </tr>
            </thead>
            <tbody>
              {fleet === null && (
                <tr>
                  <td colSpan={4} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {fleet?.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No fleet data yet.
                  </td>
                </tr>
              )}
              {fleet?.map((r) => (
                <tr key={r.tenant}>
                  <td style={{ fontWeight: 600 }}>{nameOf(r.tenant)}</td>
                  <td>{r.vehicles} vehicles</td>
                  <td>{r.activeRentals} active</td>
                  <td>
                    <UtilBar pct={r.utilization} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div className="card__title">Top companies by traffic</div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Requests</th>
                <th>Errors</th>
                <th>Error rate</th>
              </tr>
            </thead>
            <tbody>
              {(dashboard?.topTenants ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No traffic recorded for this window.
                  </td>
                </tr>
              )}
              {dashboard?.topTenants?.map((t) => (
                <tr key={t.tenantId}>
                  <td style={{ fontWeight: 600 }}>{nameOf(t.tenantId)}</td>
                  <td>{fmt(t.requests)}</td>
                  <td>{fmt(t.errors)}</td>
                  <td>
                    <span
                      className={`badge ${t.errorRate > 0.05 ? 'badge--amber' : 'badge--green'}`}
                    >
                      <span className="dot" />
                      {(t.errorRate * 100).toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(dashboard?.customMetrics ?? []).length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card__head">
            <div className="card__title">Custom metrics</div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {dashboard?.customMetrics.map((m) => (
                  <tr key={m.name}>
                    <td className="mono">{m.name}</td>
                    <td>{fmt(m.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </OperatorShell>
  )
}

function UtilBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  const tone =
    clamped >= 75
      ? 'var(--red, #d1495b)'
      : clamped >= 40
        ? 'var(--brand, #e2603b)'
        : 'var(--green, #2f9e69)'
  return (
    <div className="row" style={{ gap: 10 }}>
      <div
        style={{
          flex: 1,
          height: 8,
          borderRadius: 6,
          background: 'var(--surface-3, #e7e2dc)',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${clamped}%`, height: '100%', background: tone }} />
      </div>
      <span className="mono" style={{ fontSize: 12.5, minWidth: 38, textAlign: 'right' }}>
        {clamped}%
      </span>
    </div>
  )
}

function fmt(n: number): string {
  return new Intl.NumberFormat().format(n)
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
