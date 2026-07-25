import { useCallback, useEffect, useState } from 'react'
import { Link } from '@inertiajs/react'
import { OperatorShell, Stat, StatusBadge } from '../../components/shells'
import { api } from '../../lib/api'
import type { AdminTenant, TenantStatus } from '../../types'

type ListResponse = { data: AdminTenant[]; total: number }
type RunStatus = 'ok' | 'degraded' | 'fail'
type DoctorTotals = {
  info: number
  warn: number
  error: number
  fixable: number
  platformError: number
  tenantError: number
}
type DoctorReport = { status: RunStatus; totals: DoctorTotals }

const PLANS = ['starter', 'fleet', 'enterprise']

export default function OperatorDashboard() {
  const [tenants, setTenants] = useState<AdminTenant[] | null>(null)
  const [health, setHealth] = useState<{ totals: DoctorTotals; status: RunStatus } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const loadTenants = useCallback(async () => {
    try {
      const res = await api.get<ListResponse>('/admin/tenants?includeDeleted=true')
      setTenants(res.data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load companies')
      setTenants([])
    }
  }, [])

  const loadHealth = useCallback(async () => {
    try {
      // 200 (ok/degraded) or 503 (platform fail) — the doctor body is identical, so
      // read it raw and trust the report's own tri-state `status` rather than the
      // HTTP code, which only distinguishes fail from the rest.
      const res = await fetch('/admin/health/report', {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      })
      const body = (await res.json()) as DoctorReport
      setHealth({ totals: body.totals, status: body.status })
    } catch {
      setHealth(null)
    }
  }, [])

  useEffect(() => {
    loadTenants()
    loadHealth()
  }, [loadTenants, loadHealth])

  const act = useCallback(
    async (key: string, run: () => Promise<unknown>, message: string) => {
      setBusy(key)
      setNotice(null)
      setError(null)
      try {
        await run()
        setNotice(message)
        await Promise.all([loadTenants(), loadHealth()])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Action failed')
      } finally {
        setBusy(null)
      }
    },
    [loadTenants, loadHealth]
  )

  const counts = summarize(tenants)

  return (
    <OperatorShell title="Companies">
      <div className="page-head">
        <div>
          <h1>Companies</h1>
          <p>Provision and govern every rental company on the platform.</p>
        </div>
        <button className="btn btn--primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Close' : '+ New company'}
        </button>
      </div>

      {notice && <div className="alert alert--success">{notice}</div>}
      {error && <div className="alert alert--error">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <Stat label="Companies" value={counts.total} sub={`${counts.deleted} deleted`} />
        <Stat label="Active" value={counts.active} sub={`${counts.suspended} suspended`} />
        <Stat
          label="Provisioning"
          value={counts.provisioning}
          sub={counts.failed ? `${counts.failed} failed` : 'onboarding'}
        />
        <Stat
          label="Platform health"
          value={
            health ? (
              <span
                className={`badge ${
                  health.status === 'fail'
                    ? 'badge--red'
                    : health.status === 'degraded'
                      ? 'badge--amber'
                      : 'badge--green'
                }`}
              >
                <span className="dot" />
                {health.status === 'fail'
                  ? 'Attention'
                  : health.status === 'degraded'
                    ? 'Degraded'
                    : 'Healthy'}
              </span>
            ) : (
              '—'
            )
          }
          sub={health ? `${health.totals.error} err · ${health.totals.warn} warn` : 'doctor'}
        />
      </div>

      {showCreate && <CreateCompany busy={busy === 'create'} onCreate={act} />}

      <div className="card">
        <div className="card__head">
          <div className="card__title">All companies</div>
          <button className="btn btn--subtle btn--sm" onClick={() => loadTenants()}>
            Refresh
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Plan</th>
                <th>Schema</th>
                <th>Created</th>
                <th style={{ textAlign: 'right' }}>Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {tenants === null && (
                <tr>
                  <td colSpan={6} className="empty">
                    Loading companies…
                  </td>
                </tr>
              )}
              {tenants?.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No companies yet. Provision the first one.
                  </td>
                </tr>
              )}
              {tenants?.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link href={`/companies/${t.id}`} style={{ fontWeight: 600 }}>
                      {t.name}
                    </Link>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {t.customDomain ?? t.email}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                  <td>
                    <span className="badge badge--slate">{t.metadata?.plan ?? 'starter'}</span>
                  </td>
                  <td className="mono truncate">{t.schemaName}</td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {formatDate(t.createdAt)}
                  </td>
                  <td>
                    <LifecycleActions tenant={t} busy={busy} act={act} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </OperatorShell>
  )
}

/* ─── Per-row lifecycle actions (drive the tenant state machine) ──────────── */

function LifecycleActions({
  tenant: t,
  busy,
  act,
}: {
  tenant: AdminTenant
  busy: string | null
  act: (key: string, run: () => Promise<unknown>, message: string) => Promise<void>
}) {
  const disabled = busy !== null
  const btns: { key: string; label: string; run: () => Promise<unknown>; msg: string; danger?: boolean }[] =
    []

  const isActive: boolean = t.status === 'active'
  const isSuspended: boolean = t.status === 'suspended'
  const isDeleted: boolean = t.status === 'deleted'

  if (isSuspended || t.status === 'provisioning' || t.status === 'failed') {
    btns.push({
      key: `${t.id}:activate`,
      label: 'Activate',
      run: () => api.post(`/admin/tenants/${t.id}/activate`),
      msg: `${t.name} activated.`,
    })
  }
  if (isActive) {
    btns.push({
      key: `${t.id}:suspend`,
      label: 'Suspend',
      run: () => api.post(`/admin/tenants/${t.id}/suspend`),
      msg: `${t.name} suspended.`,
    })
    btns.push({
      key: `${t.id}:maintenance`,
      label: 'Maintenance',
      run: () => api.post(`/admin/tenants/${t.id}/maintenance`, { message: 'Scheduled maintenance' }),
      msg: `${t.name} entered maintenance.`,
    })
  }
  if (isDeleted) {
    btns.push({
      key: `${t.id}:restore`,
      label: 'Restore',
      run: () => api.post(`/admin/tenants/${t.id}/restore`),
      msg: `${t.name} restored.`,
    })
  }
  if (isActive || isSuspended) {
    btns.push({
      key: `${t.id}:destroy`,
      label: 'Destroy',
      danger: true,
      run: () => {
        if (!confirm(`Destroy ${t.name}? Its schema will be dropped.`)) {
          return Promise.reject(new Error('cancelled'))
        }
        return api.post(`/admin/tenants/${t.id}/destroy?keepSchema=false`)
      },
      msg: `${t.name} destroyed.`,
    })
  }

  return (
    <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {btns.map((b) => (
        <button
          key={b.key}
          className={`btn btn--sm ${b.danger ? 'btn--danger' : 'btn--ghost'}`}
          disabled={disabled}
          onClick={() =>
            act(b.key, b.run, b.msg).catch(() => {
              /* cancelled confirm — swallow */
            })
          }
        >
          {busy === b.key ? '…' : b.label}
        </button>
      ))}
    </div>
  )
}

/* ─── Create company form ────────────────────────────────────────────────── */

function CreateCompany({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (key: string, run: () => Promise<unknown>, message: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [plan, setPlan] = useState('starter')

  const submit = () => {
    onCreate(
      'create',
      () =>
        api.post('/admin/tenants', {
          name,
          email,
          metadata: { plan },
        }),
      `${name} is provisioning — the install job is running.`
    ).then(() => {
      setName('')
      setEmail('')
      setPlan('starter')
    })
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card__head">
        <div className="card__title">Provision a new company</div>
      </div>
      <div className="card__body">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field__label">Company name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Cars" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field__label">Owner email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@acme.example"
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field__label">Plan</label>
            <select className="select" value={plan} onChange={(e) => setPlan(e.target.value)}>
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn--primary" disabled={busy || !name || !email} onClick={submit}>
            {busy ? 'Provisioning…' : 'Provision company'}
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            Dispatches the async InstallTenant job — watch the status flip provisioning → active.
          </span>
        </div>
      </div>
    </div>
  )
}

/* ─── helpers ────────────────────────────────────────────────────────────── */

function summarize(tenants: AdminTenant[] | null) {
  const c = { total: 0, active: 0, suspended: 0, provisioning: 0, failed: 0, deleted: 0 }
  if (!tenants) return c
  for (const t of tenants) {
    c.total += 1
    c[t.status as keyof typeof c] = (c[t.status as keyof typeof c] ?? 0) + 1
  }
  return c
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}

export type { TenantStatus }
