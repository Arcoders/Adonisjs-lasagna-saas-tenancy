import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { TenantShell } from '../../components/shells'
import { api, ApiError } from '../../lib/api'

/* Company self-service: branding, feature flags and SSO, each scoped to the
 * caller's own company via the tenant-guarded `/settings/*` API. Same underlying
 * core services the operator console drives, so the two never drift. */

type Tab = 'branding' | 'flags' | 'sso'
const TABS: { key: Tab; label: string }[] = [
  { key: 'branding', label: 'Branding' },
  { key: 'flags', label: 'Feature flags' },
  { key: 'sso', label: 'SSO' },
]

export default function Settings() {
  const [tab, setTab] = useState<Tab>('branding')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    setNotice(null)
    setError(null)
    try {
      await fn()
      setNotice(ok)
      return true
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed')
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const shared = { busy, run }

  return (
    <TenantShell title="Settings" activeHref="/settings">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Brand the customer-facing pages, flip the features you run, and wire your own SSO.</p>
        </div>
      </div>

      <div className="row row--wrap" style={{ gap: 6, marginBottom: 18 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`btn btn--sm ${tab === t.key ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => {
              setTab(t.key)
              setNotice(null)
              setError(null)
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {notice && <div className="alert alert--success">{notice}</div>}
      {error && <div className="alert alert--error">{error}</div>}

      {tab === 'branding' && <BrandingTab {...shared} />}
      {tab === 'flags' && <FlagsTab {...shared} />}
      {tab === 'sso' && <SsoTab {...shared} />}
    </TenantShell>
  )
}

type TabProps = { busy: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean> }

/* ─── Branding ───────────────────────────────────────────────────────────── */

type Branding = {
  fromName: string | null
  fromEmail: string | null
  logoUrl: string | null
  primaryColor: string | null
  supportUrl: string | null
}

function BrandingTab({ busy, run }: TabProps) {
  const [form, setForm] = useState<Branding>(EMPTY_BRANDING)

  const load = useCallback(async () => {
    const res = await api
      .get<{ data: Branding | null }>('/settings/branding')
      .catch(() => ({ data: null }))
    setForm({ ...EMPTY_BRANDING, ...(res.data ?? {}) })
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const set = (k: keyof Branding) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const save = () =>
    run(
      () => api.put('/settings/branding', form),
      'Branding saved — customer pages will use it.'
    ).then((ok) => {
      if (ok) load()
    })

  const color = form.primaryColor || '#e2603b'

  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">Brand identity</div>
      </div>
      <div className="card__body">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
            gap: 16,
          }}
        >
          <Field label="From name">
            <input
              className="input"
              value={form.fromName ?? ''}
              onChange={(e) => set('fromName')(e.target.value)}
              placeholder="Acme Cars"
            />
          </Field>
          <Field label="From email">
            <input
              className="input"
              value={form.fromEmail ?? ''}
              onChange={(e) => set('fromEmail')(e.target.value)}
              placeholder="hello@acme.ma"
            />
          </Field>
          <Field label="Logo URL">
            <input
              className="input"
              value={form.logoUrl ?? ''}
              onChange={(e) => set('logoUrl')(e.target.value)}
              placeholder="https://…/logo.png"
            />
          </Field>
          <Field label="Support URL">
            <input
              className="input"
              value={form.supportUrl ?? ''}
              onChange={(e) => set('supportUrl')(e.target.value)}
              placeholder="https://acme.ma/help"
            />
          </Field>
          <Field label="Primary color">
            <div className="row" style={{ gap: 8 }}>
              <input
                type="color"
                value={/^#(?:[0-9a-fA-F]{3}){1,2}$/.test(color) ? color : '#e2603b'}
                onChange={(e) => set('primaryColor')(e.target.value)}
                style={{
                  width: 44,
                  height: 38,
                  borderRadius: 8,
                  border: '1px solid var(--line,#ddd)',
                  padding: 2,
                  background: 'none',
                }}
              />
              <input
                className="input"
                value={form.primaryColor ?? ''}
                onChange={(e) => set('primaryColor')(e.target.value)}
                placeholder="#e2603b"
              />
            </div>
          </Field>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn--primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save branding'}
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            An empty field clears that value.
          </span>
        </div>
      </div>
    </div>
  )
}

const EMPTY_BRANDING: Branding = {
  fromName: '',
  fromEmail: '',
  logoUrl: '',
  primaryColor: '',
  supportUrl: '',
}

/* ─── Feature flags ──────────────────────────────────────────────────────── */

type Flag = { flag: string; enabled: boolean }
const FLAG_LABELS: Record<string, string> = {
  online_checkin: 'Online check-in',
  dynamic_pricing: 'Dynamic pricing',
  ai_assistant: 'AI assistant',
}

function FlagsTab({ busy, run }: TabProps) {
  const [flags, setFlags] = useState<Record<string, boolean>>({})
  const [available, setAvailable] = useState<string[]>([])

  const load = useCallback(async () => {
    const res = await api
      .get<{ data: Flag[]; selfServiceable: string[] }>('/settings/flags')
      .catch(() => ({ data: [] as Flag[], selfServiceable: [] as string[] }))
    const map: Record<string, boolean> = {}
    for (const f of res.data) map[f.flag] = f.enabled
    setFlags(map)
    setAvailable(res.selfServiceable ?? [])
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const toggle = (flag: string, next: boolean) =>
    run(
      () => api.put(`/settings/flags/${encodeURIComponent(flag)}`, { enabled: next }),
      `${FLAG_LABELS[flag] ?? flag} ${next ? 'enabled' : 'disabled'}.`
    ).then((ok) => {
      if (ok) load()
    })

  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">Features</div>
      </div>
      <div className="card__body" style={{ padding: 0 }}>
        {available.length === 0 && (
          <div className="empty" style={{ padding: 20 }}>
            No self-service features.
          </div>
        )}
        {available.map((flag) => {
          const on = flags[flag] ?? false
          return (
            <div
              key={flag}
              className="row"
              style={{
                justifyContent: 'space-between',
                padding: '14px 18px',
                borderTop: '1px solid var(--line,#eee)',
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{FLAG_LABELS[flag] ?? flag}</div>
                <div className="mono muted" style={{ fontSize: 12.5 }}>
                  {flag}
                </div>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <span className={`badge ${on ? 'badge--green' : 'badge--slate'}`}>
                  <span className="dot" />
                  {on ? 'On' : 'Off'}
                </span>
                <button
                  className={`btn btn--sm ${on ? 'btn--ghost' : 'btn--primary'}`}
                  disabled={busy}
                  onClick={() => toggle(flag, !on)}
                >
                  {on ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ─── SSO ────────────────────────────────────────────────────────────────── */

type SsoConfig = {
  clientId: string
  issuerUrl: string
  redirectUri: string
  scopes: string[]
  enabled: boolean
  hasClientSecret: boolean
}

function SsoTab({ busy, run }: TabProps) {
  const [config, setConfig] = useState<SsoConfig | null>(null)
  const [notInstalled, setNotInstalled] = useState(false)
  const [form, setForm] = useState({
    clientId: '',
    clientSecret: '',
    issuerUrl: '',
    redirectUri: '',
    scopes: 'openid, email, profile',
  })

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: SsoConfig | null }>('/settings/sso')
      setConfig(res.data)
      if (res.data) {
        setForm((f) => ({
          ...f,
          clientId: res.data!.clientId,
          issuerUrl: res.data!.issuerUrl,
          redirectUri: res.data!.redirectUri,
          scopes: (res.data!.scopes ?? []).join(', '),
        }))
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) setNotInstalled(true)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const scopesList = form.scopes
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const save = () =>
    run(
      () =>
        api.put('/settings/sso', {
          clientId: form.clientId,
          clientSecret: form.clientSecret,
          issuerUrl: form.issuerUrl,
          redirectUri: form.redirectUri,
          ...(scopesList.length ? { scopes: scopesList } : {}),
        }),
      'SSO configured — your IdP is now wired.'
    ).then((ok) => {
      if (ok) {
        setForm((f) => ({ ...f, clientSecret: '' }))
        load()
      }
    })

  const disable = () =>
    run(() => api.post('/settings/sso/disable'), 'SSO disabled.').then((ok) => {
      if (ok) load()
    })

  if (notInstalled) {
    return (
      <div className="card">
        <div className="card__body">
          <div className="empty" style={{ padding: 20 }}>
            SSO is not installed on this platform (the{' '}
            <span className="mono">@adonisjs-lasagna/sso</span> peer is absent).
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">OpenID Connect</div>
        {config && (
          <span className={`badge ${config.enabled ? 'badge--green' : 'badge--slate'}`}>
            <span className="dot" />
            {config.enabled ? 'Enabled' : 'Disabled'}
          </span>
        )}
      </div>
      <div className="card__body">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))',
            gap: 16,
          }}
        >
          <Field label="Client ID">
            <input
              className="input"
              value={form.clientId}
              onChange={(e) => set('clientId')(e.target.value)}
              placeholder="acme-rentals"
            />
          </Field>
          <Field
            label={
              config?.hasClientSecret
                ? 'Client secret (set — leave blank to keep)'
                : 'Client secret'
            }
          >
            <input
              className="input"
              type="password"
              value={form.clientSecret}
              onChange={(e) => set('clientSecret')(e.target.value)}
              placeholder={config?.hasClientSecret ? '••••••••' : 'secret'}
            />
          </Field>
          <Field label="Issuer URL (https)">
            <input
              className="input"
              value={form.issuerUrl}
              onChange={(e) => set('issuerUrl')(e.target.value)}
              placeholder="https://idp.acme.ma"
            />
          </Field>
          <Field label="Redirect URI (https)">
            <input
              className="input"
              value={form.redirectUri}
              onChange={(e) => set('redirectUri')(e.target.value)}
              placeholder="https://acme.localhost/sso/callback"
            />
          </Field>
          <Field label="Scopes (comma-separated)">
            <input
              className="input"
              value={form.scopes}
              onChange={(e) => set('scopes')(e.target.value)}
              placeholder="openid, email, profile"
            />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn--primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : config ? 'Update SSO' : 'Enable SSO'}
          </button>
          {config?.enabled && (
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={disable}>
              Disable
            </button>
          )}
          <span className="muted" style={{ fontSize: 13 }}>
            The issuer URL is fetched server-side, so it must be a public https host (SSRF-guarded).
          </span>
        </div>
      </div>
    </div>
  )
}

/* ─── bits ───────────────────────────────────────────────────────────────── */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label className="field__label">{label}</label>
      {children}
    </div>
  )
}
