import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { usePage, router } from '@inertiajs/react'
import { OperatorShell, Stat, StatusBadge } from '../../components/shells'
import { api, ApiError } from '../../lib/api'
import type { AdminTenant } from '../../types'

/*
 * The per-company control panel. Everything here drives the admin satellite
 * under `/admin/tenants/:id/...` — the operator session already authorizes those
 * routes, so the session cookie is all the auth these calls carry.
 *
 * The panel is tabbed: each tab lazy-loads its own slice on first open (it only
 * mounts once selected) and carries a Refresh button. Notice/error/busy are
 * top-level and shared, exactly like operator/dashboard.tsx.
 */

type Tab = 'overview' | 'flags' | 'webhooks' | 'audit' | 'metrics' | 'quotas'

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'flags', label: 'Feature flags' },
  { key: 'webhooks', label: 'Webhooks' },
  { key: 'audit', label: 'Audit log' },
  { key: 'metrics', label: 'Metrics' },
  { key: 'quotas', label: 'Quotas' },
]

/** The shared action runner — same shape the fleet/dashboard pages copy. */
type Run = (
  key: string,
  fn: () => Promise<unknown>,
  message: string,
  reload?: () => Promise<unknown>
) => Promise<void>

type TabProps = {
  tenantId: string
  busy: string | null
  run: Run
  setError: (m: string | null) => void
}

export default function OperatorCompany() {
  const { tenantId } = usePage<{ tenantId: string }>().props

  const [tenant, setTenant] = useState<AdminTenant | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const loadTenant = useCallback(async () => {
    try {
      const res = await api.get<{ data: AdminTenant }>(`/admin/tenants/${tenantId}`)
      setTenant(res.data)
    } catch (e) {
      setError(errMessage(e))
    }
  }, [tenantId])

  useEffect(() => {
    loadTenant()
  }, [loadTenant])

  const run = useCallback<Run>(async (key, fn, message, reload) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await fn()
      setNotice(message)
      if (reload) await reload()
    } catch (e) {
      // A cancelled confirm() rejects with this sentinel — leave the UI quiet.
      if (!(e instanceof Error && e.message === 'cancelled')) {
        setError(errMessage(e))
      }
    } finally {
      setBusy(null)
    }
  }, [])

  const selectTab = (next: Tab) => {
    setTab(next)
    setNotice(null)
    setError(null)
  }

  const shared: TabProps = { tenantId, busy, run, setError }

  return (
    <OperatorShell title="Company">
      <div className="page-head">
        <div>
          <a
            href="/"
            className="muted"
            style={{ fontSize: 13, fontWeight: 600 }}
            onClick={(e) => {
              e.preventDefault()
              router.visit('/')
            }}
          >
            ← Companies
          </a>
          <h1 style={{ marginTop: 6 }}>{tenant?.name ?? 'Company'}</h1>
          <p>Feature flags, webhooks, audit trail, usage metrics and quotas for this company.</p>
        </div>
        {tenant && <StatusBadge status={tenant.status} />}
      </div>

      {notice && <div className="alert alert--success">{notice}</div>}
      {error && <div className="alert alert--error">{error}</div>}

      <div className="row row--wrap" style={{ marginBottom: 20 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`btn btn--sm ${tab === t.key ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => selectTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewTab tenantId={tenantId} tenant={tenant} busy={busy} run={run} reload={loadTenant} />
      )}
      {tab === 'flags' && <FlagsTab {...shared} />}
      {tab === 'webhooks' && <WebhooksTab {...shared} />}
      {tab === 'audit' && <AuditTab {...shared} />}
      {tab === 'metrics' && <MetricsTab {...shared} />}
      {tab === 'quotas' && <QuotasTab {...shared} />}
    </OperatorShell>
  )
}

/* ─── Overview ───────────────────────────────────────────────────────────── */

function OverviewTab({
  tenantId,
  tenant,
  busy,
  run,
  reload,
}: {
  tenantId: string
  tenant: AdminTenant | null
  busy: string | null
  run: Run
  reload: () => Promise<unknown>
}) {
  const [queue, setQueue] = useState<Record<string, any> | null>(null)
  const [userId, setUserId] = useState('')
  const [reason, setReason] = useState('')
  const [token, setToken] = useState<string | null>(null)

  const loadQueue = useCallback(async () => {
    try {
      const res = await api.get<{ data: unknown }>(`/admin/tenants/${tenantId}/queue/stats`)
      setQueue(isObj(res.data) ? res.data : null)
    } catch {
      // Queue stats are best-effort — a missing driver shouldn't blank the tab.
      setQueue(null)
    }
  }, [tenantId])

  useEffect(() => {
    loadQueue()
  }, [loadQueue])

  const lifecycle = buildLifecycle(tenant)

  const impersonate = () =>
    run(
      'impersonate',
      async () => {
        const res = await api.post<{ data?: { token?: string } }>(
          `/admin/tenants/${tenantId}/impersonations`,
          { userId: userId.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) }
        )
        setToken(res?.data?.token ?? null)
      },
      'Impersonation token minted.'
    )

  return (
    <div className="stack">
      <div className="card">
        <div className="card__head">
          <div className="card__title">Identity & lifecycle</div>
          <button
            className="btn btn--subtle btn--sm"
            onClick={() => {
              reload()
              loadQueue()
            }}
          >
            Refresh
          </button>
        </div>
        <div className="card__body">
          {tenant === null ? (
            <div className="empty">Loading company…</div>
          ) : (
            <>
              <div className="row row--wrap" style={{ gap: 24, marginBottom: 20 }}>
                <Meta label="Status">
                  <StatusBadge status={tenant.status} />
                </Meta>
                <Meta label="Email" value={tenant.email} />
                <Meta label="Plan">
                  <span className="badge badge--slate">{tenant.metadata?.plan ?? 'starter'}</span>
                </Meta>
                <Meta label="Schema" mono>
                  {tenant.schemaName}
                </Meta>
                <Meta label="Company ID" mono>
                  {tenant.id}
                </Meta>
              </div>

              <div className="row row--wrap">
                {lifecycle.length === 0 && (
                  <span className="muted" style={{ fontSize: 13 }}>
                    No lifecycle actions available for this status.
                  </span>
                )}
                {lifecycle.map((b) => (
                  <button
                    key={b.key}
                    className={`btn btn--sm ${b.danger ? 'btn--danger' : 'btn--ghost'}`}
                    disabled={busy !== null}
                    onClick={() => run(b.key, b.fn, b.msg, reload)}
                  >
                    {busy === b.key ? '…' : b.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div className="card__title">Queue</div>
          <button className="btn btn--subtle btn--sm" onClick={loadQueue}>
            Refresh
          </button>
        </div>
        <div className="card__body">
          {queue === null ? (
            <div className="muted" style={{ fontSize: 13 }}>
              No queue stats available.
            </div>
          ) : Object.keys(queue).length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>
              Queue is idle.
            </div>
          ) : (
            <div className="row row--wrap">
              {Object.entries(queue).map(([k, v]) => (
                <span key={k} className="badge badge--slate">
                  {k}
                  <strong className="mono" style={{ marginLeft: 4 }}>
                    {text(v)}
                  </strong>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div className="card__title">Impersonate</div>
        </div>
        <div className="card__body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Mint a short-lived token to act as a company user. Needs an admin actor resolver
            configured on the platform.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field__label">User ID</label>
              <input
                className="input"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="user uuid"
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field__label">Reason (optional)</label>
              <input
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="support ticket #123"
              />
            </div>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="btn btn--primary btn--sm"
              disabled={!userId.trim() || busy === 'impersonate'}
              onClick={impersonate}
            >
              {busy === 'impersonate' ? 'Minting…' : 'Mint token'}
            </button>
          </div>
          {token && (
            <div className="alert alert--success" style={{ marginTop: 14, marginBottom: 0 }}>
              Token:{' '}
              <span
                className="mono truncate"
                style={{ display: 'inline-block', verticalAlign: 'bottom', maxWidth: 340 }}
              >
                {token}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function buildLifecycle(t: AdminTenant | null) {
  const out: { key: string; label: string; fn: () => Promise<unknown>; msg: string; danger?: boolean }[] = []
  if (!t) return out

  const id = t.id
  const isActive = t.status === 'active'
  const isSuspended = t.status === 'suspended'
  const isDeleted = t.status === 'deleted'

  if (isSuspended || t.status === 'provisioning' || t.status === 'failed') {
    out.push({
      key: 'activate',
      label: 'Activate',
      fn: () => api.post(`/admin/tenants/${id}/activate`),
      msg: `${t.name} activated.`,
    })
  }
  if (isActive) {
    out.push({
      key: 'suspend',
      label: 'Suspend',
      fn: () => api.post(`/admin/tenants/${id}/suspend`),
      msg: `${t.name} suspended.`,
    })
    out.push({
      key: 'maintenance',
      label: 'Maintenance',
      fn: () => api.post(`/admin/tenants/${id}/maintenance`, { message: 'Scheduled maintenance' }),
      msg: `${t.name} entered maintenance.`,
    })
  }
  if (isDeleted) {
    out.push({
      key: 'restore',
      label: 'Restore',
      fn: () => api.post(`/admin/tenants/${id}/restore`),
      msg: `${t.name} restored.`,
    })
  }
  if (isActive || isSuspended) {
    out.push({
      key: 'destroy',
      label: 'Destroy',
      danger: true,
      msg: `${t.name} destroyed.`,
      fn: () => {
        if (!confirm(`Destroy ${t.name}? Its schema will be dropped.`)) {
          return Promise.reject(new Error('cancelled'))
        }
        return api.post(`/admin/tenants/${id}/destroy?keepSchema=false`)
      },
    })
  }
  return out
}

/* ─── Feature flags ──────────────────────────────────────────────────────── */

type Flag = { flag: string; enabled: boolean; config?: any; expiresAt?: string | null }

function FlagsTab({ tenantId, busy, run, setError }: TabProps) {
  const [flags, setFlags] = useState<Flag[] | null>(null)
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Flag[] }>(`/admin/tenants/${tenantId}/feature-flags`)
      setFlags(Array.isArray(res.data) ? res.data : [])
    } catch (e) {
      setError(errMessage(e))
      setFlags([])
    }
  }, [tenantId, setError])

  useEffect(() => {
    load()
  }, [load])

  const create = () =>
    run(
      'flag-create',
      () => api.post(`/admin/tenants/${tenantId}/feature-flags`, { flag: name.trim(), enabled }),
      `Flag ${name.trim()} saved.`,
      load
    ).then(() => setName(''))

  const toggle = (f: Flag) =>
    run(
      `flag:${f.flag}`,
      () =>
        api.put(`/admin/tenants/${tenantId}/feature-flags/${encodeURIComponent(f.flag)}`, {
          enabled: !f.enabled,
        }),
      `Flag ${f.flag} ${!f.enabled ? 'enabled' : 'disabled'}.`,
      load
    )

  const remove = (f: Flag) =>
    run(
      `flag-del:${f.flag}`,
      () => {
        if (!confirm(`Delete flag ${f.flag}?`)) return Promise.reject(new Error('cancelled'))
        return api.del(`/admin/tenants/${tenantId}/feature-flags/${encodeURIComponent(f.flag)}`)
      },
      `Flag ${f.flag} deleted.`,
      load
    )

  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">Feature flags</div>
        <button className="btn btn--subtle btn--sm" onClick={load}>
          Refresh
        </button>
      </div>
      <div className="card__body">
        <div className="row row--wrap" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
          <div className="field" style={{ marginBottom: 0, flex: '1 1 240px' }}>
            <label className="field__label">Flag name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="online_checkin"
            />
          </div>
          <label className="row" style={{ gap: 8, fontSize: 14, marginBottom: 9 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <button
            className="btn btn--primary btn--sm"
            style={{ marginBottom: 9 }}
            disabled={!name.trim() || busy === 'flag-create'}
            onClick={create}
          >
            {busy === 'flag-create' ? 'Saving…' : 'Add flag'}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>
          Common flags: <span className="mono">online_checkin</span>,{' '}
          <span className="mono">dynamic_pricing</span>, <span className="mono">ai_assistant</span>.
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Flag</th>
                <th>State</th>
                <th>Expires</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {flags === null && (
                <tr>
                  <td colSpan={4} className="empty">
                    Loading flags…
                  </td>
                </tr>
              )}
              {flags?.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No feature flags set for this company.
                  </td>
                </tr>
              )}
              {flags?.map((f) => (
                <tr key={f.flag}>
                  <td className="mono">{f.flag}</td>
                  <td>
                    <span className={`badge ${f.enabled ? 'badge--green' : 'badge--slate'}`}>
                      <span className="dot" />
                      {f.enabled ? 'on' : 'off'}
                    </span>
                  </td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {f.expiresAt ? fmtDate(f.expiresAt) : '—'}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn--ghost btn--sm"
                        disabled={busy !== null}
                        onClick={() => toggle(f)}
                      >
                        {busy === `flag:${f.flag}` ? '…' : f.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="btn btn--danger btn--sm"
                        disabled={busy !== null}
                        onClick={() => remove(f)}
                      >
                        {busy === `flag-del:${f.flag}` ? '…' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ─── Webhooks ───────────────────────────────────────────────────────────── */

type Webhook = { id: string; url: string; events: string[]; enabled: boolean; hasSecret: boolean }

function WebhooksTab({ tenantId, busy, run, setError }: TabProps) {
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState('')
  const [secret, setSecret] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Webhook[] }>(`/admin/tenants/${tenantId}/webhooks`)
      setHooks(Array.isArray(res.data) ? res.data : [])
    } catch (e) {
      setError(errMessage(e))
      setHooks([])
    }
  }, [tenantId, setError])

  useEffect(() => {
    load()
  }, [load])

  const create = () =>
    run(
      'wh-create',
      async () => {
        const evs = events
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const res = await api.post<any>(`/admin/tenants/${tenantId}/webhooks`, {
          url: url.trim(),
          events: evs,
        })
        // The signing secret is shown once, on creation only.
        const s = res?.secret ?? res?.data?.secret
        if (s) setSecret(String(s))
      },
      'Webhook created.',
      load
    ).then(() => {
      setUrl('')
      setEvents('')
    })

  const toggle = (w: Webhook) =>
    run(
      `wh:${w.id}`,
      () => api.put(`/admin/tenants/${tenantId}/webhooks/${w.id}`, { enabled: !w.enabled }),
      `Webhook ${!w.enabled ? 'enabled' : 'disabled'}.`,
      load
    )

  const remove = (w: Webhook) =>
    run(
      `wh-del:${w.id}`,
      () => {
        if (!confirm(`Delete webhook to ${w.url}?`)) return Promise.reject(new Error('cancelled'))
        return api.del(`/admin/tenants/${tenantId}/webhooks/${w.id}`)
      },
      'Webhook deleted.',
      load
    )

  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">Webhooks</div>
        <button className="btn btn--subtle btn--sm" onClick={load}>
          Refresh
        </button>
      </div>
      <div className="card__body">
        {secret && (
          <div className="alert alert--success">
            Signing secret (shown once — copy it now):{' '}
            <span
              className="mono truncate"
              style={{ display: 'inline-block', verticalAlign: 'bottom', maxWidth: 340 }}
            >
              {secret}
            </span>
          </div>
        )}
        <div className="row row--wrap" style={{ alignItems: 'flex-end', marginBottom: 18 }}>
          <div className="field" style={{ marginBottom: 0, flex: '1 1 260px' }}>
            <label className="field__label">Endpoint URL</label>
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.acme.example/karimoto"
            />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: '1 1 260px' }}>
            <label className="field__label">Events (comma-separated)</label>
            <input
              className="input"
              value={events}
              onChange={(e) => setEvents(e.target.value)}
              placeholder="booking.created, invoice.paid"
            />
          </div>
          <button
            className="btn btn--primary btn--sm"
            style={{ marginBottom: 1 }}
            disabled={!url.trim() || busy === 'wh-create'}
            onClick={create}
          >
            {busy === 'wh-create' ? 'Creating…' : 'Add webhook'}
          </button>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Events</th>
                <th>State</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {hooks === null && (
                <tr>
                  <td colSpan={4} className="empty">
                    Loading webhooks…
                  </td>
                </tr>
              )}
              {hooks?.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No webhooks configured.
                  </td>
                </tr>
              )}
              {hooks?.map((w) => (
                <tr key={w.id}>
                  <td>
                    <div className="mono truncate">{w.url}</div>
                    {w.hasSecret && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        signed
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="row row--wrap" style={{ gap: 6 }}>
                      {(w.events ?? []).length === 0 && <span className="muted">—</span>}
                      {(w.events ?? []).map((ev) => (
                        <span key={ev} className="badge badge--slate">
                          {ev}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${w.enabled ? 'badge--green' : 'badge--slate'}`}>
                      <span className="dot" />
                      {w.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn--ghost btn--sm"
                        disabled={busy !== null}
                        onClick={() => toggle(w)}
                      >
                        {busy === `wh:${w.id}` ? '…' : w.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="btn btn--danger btn--sm"
                        disabled={busy !== null}
                        onClick={() => remove(w)}
                      >
                        {busy === `wh-del:${w.id}` ? '…' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ─── Audit log ──────────────────────────────────────────────────────────── */

function AuditTab({ tenantId, setError }: TabProps) {
  const [rows, setRows] = useState<Record<string, any>[] | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Record<string, any>[] }>(
        `/admin/tenants/${tenantId}/audit-logs?page=1&limit=50`
      )
      setRows(Array.isArray(res.data) ? res.data : [])
    } catch (e) {
      setError(errMessage(e))
      setRows([])
    }
  }, [tenantId, setError])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">Audit log</div>
        <button className="btn btn--subtle btn--sm" onClick={load}>
          Refresh
        </button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Actor</th>
              <th>IP</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={4} className="empty">
                  Loading audit log…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  No audit entries recorded.
                </td>
              </tr>
            )}
            {rows?.map((r, i) => {
              const actor = r.actorId ?? r.actor_id
              const actorType = r.actorType ?? r.actor_type
              const ip = r.ipAddress ?? r.ip_address ?? r.ip
              return (
                <tr key={r.id ?? i}>
                  <td className="mono">{text(r.action ?? r.event)}</td>
                  <td>
                    {actor ? (
                      <>
                        <span className="mono">{text(actor)}</span>
                        {actorType && (
                          <span className="muted" style={{ marginLeft: 6, fontSize: 12.5 }}>
                            {text(actorType)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">system</span>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {text(ip)}
                  </td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {fmtDate(r.createdAt ?? r.created_at)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─── Metrics ────────────────────────────────────────────────────────────── */

function MetricsTab({ tenantId, setError }: TabProps) {
  const [rows, setRows] = useState<Record<string, any>[] | null>(null)
  const [days, setDays] = useState(30)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: Record<string, any>[]; days?: number }>(
        `/admin/tenants/${tenantId}/metrics?days=${days}`
      )
      setRows(Array.isArray(res.data) ? res.data : [])
    } catch (e) {
      setError(errMessage(e))
      setRows([])
    }
  }, [tenantId, days, setError])

  useEffect(() => {
    load()
  }, [load])

  const totals = useMemo(() => {
    let req = 0
    let err = 0
    let bw = 0
    for (const r of rows ?? []) {
      req += num(r.requestCount ?? r.request_count)
      err += num(r.errorCount ?? r.error_count)
      bw += num(r.bandwidthBytes ?? r.bandwidth_bytes)
    }
    return { req, err, bw }
  }, [rows])

  return (
    <div className="stack">
      <div className="stat-grid">
        <Stat label="Requests" value={totals.req.toLocaleString()} sub={`last ${days} days`} />
        <Stat label="Errors" value={totals.err.toLocaleString()} sub={errRate(totals.req, totals.err)} />
        <Stat label="Bandwidth" value={fmtBytes(totals.bw)} sub="egress" />
        <Stat label="Days sampled" value={rows?.length ?? 0} sub={`window ${days}d`} />
      </div>

      <div className="card">
        <div className="card__head">
          <div className="card__title">Daily usage</div>
          <div className="row">
            <select
              className="select"
              style={{ width: 130, display: 'inline-block' }}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[7, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
            <button className="btn btn--subtle btn--sm" onClick={load}>
              Refresh
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Requests</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr>
                  <td colSpan={3} className="empty">
                    Loading metrics…
                  </td>
                </tr>
              )}
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">
                    No usage recorded in this window.
                  </td>
                </tr>
              )}
              {rows?.map((r, i) => (
                <tr key={text(r.date ?? r.day) + i}>
                  <td className="mono">{text(r.date ?? r.day)}</td>
                  <td>{num(r.requestCount ?? r.request_count).toLocaleString()}</td>
                  <td>{num(r.errorCount ?? r.error_count).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ─── Quotas ─────────────────────────────────────────────────────────────── */

function QuotasTab({ tenantId, busy, run, setError }: TabProps) {
  const [data, setData] = useState<Record<string, any> | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  const load = useCallback(async () => {
    setUnavailable(false)
    try {
      const res = await api.get<{ data: unknown }>(`/admin/tenants/${tenantId}/quotas`)
      setData(isObj(res.data) ? res.data : {})
    } catch (e) {
      // 503 quotas_unavailable = the quota service is simply not enabled here.
      if (e instanceof ApiError && (e.status === 503 || e.code === 'quotas_unavailable')) {
        setUnavailable(true)
        setData(null)
      } else {
        setError(errMessage(e))
        setData({})
      }
    }
  }, [tenantId, setError])

  useEffect(() => {
    load()
  }, [load])

  const reset = () =>
    run('quota-reset', () => api.post(`/admin/tenants/${tenantId}/quotas/reset`, {}), 'Quotas reset.', load)

  const entries = data ? Object.entries(data) : []

  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">Quotas</div>
        <div className="row">
          <button
            className="btn btn--danger btn--sm"
            disabled={unavailable || busy !== null}
            onClick={reset}
          >
            {busy === 'quota-reset' ? '…' : 'Reset all'}
          </button>
          <button className="btn btn--subtle btn--sm" onClick={load}>
            Refresh
          </button>
        </div>
      </div>
      {unavailable ? (
        <div className="empty">Quota service is not enabled for this company.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Quota</th>
                <th>Used</th>
                <th>Limit</th>
              </tr>
            </thead>
            <tbody>
              {data === null && (
                <tr>
                  <td colSpan={3} className="empty">
                    Loading quotas…
                  </td>
                </tr>
              )}
              {data !== null && entries.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">
                    No quotas tracked.
                  </td>
                </tr>
              )}
              {entries.map(([name, v]) => {
                const used = isObj(v) ? v.used ?? v.current ?? v.count : v
                const limit = isObj(v) ? v.limit ?? v.max ?? v.quota : null
                return (
                  <tr key={name}>
                    <td className="mono">{name}</td>
                    <td>{text(used)}</td>
                    <td className="muted">{text(limit)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ─── bits & helpers ─────────────────────────────────────────────────────── */

function Meta({
  label,
  value,
  children,
  mono,
}: {
  label: string
  value?: ReactNode
  children?: ReactNode
  mono?: boolean
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="stat__label">{label}</div>
      <div className={mono ? 'mono truncate' : ''} style={{ marginTop: 6 }}>
        {children ?? value}
      </div>
    </div>
  )
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Action failed'
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function text(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function errRate(req: number, err: number): string {
  if (req <= 0) return 'no traffic'
  return `${((err / req) * 100).toFixed(1)}% error rate`
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
}

function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  const unit = units[i] ?? 'B'
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${unit}`
}
