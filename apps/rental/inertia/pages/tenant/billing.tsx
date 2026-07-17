import { useCallback, useEffect, useState } from 'react'
import { usePage } from '@inertiajs/react'
import { TenantShell, Stat } from '../../components/shells'
import { api, ApiError } from '../../lib/api'
import type { SharedProps } from '../../types'

type PlanId = 'starter' | 'fleet' | 'enterprise'

type Billing = {
  plan: string
  hasCustomer: boolean
  providerCustomerId: string | null
}

/*
 * The subscription tiers the rental company buys from Karimoto. The quota copy
 * mirrors config/multitenancy.ts `plans.definitions`; the authoritative limits
 * are enforced server-side by QuotaService, this is just the shopfront.
 */
const PLANS: { id: PlanId; name: string; blurb: string; limits: string[] }[] = [
  {
    id: 'starter',
    name: 'Starter',
    blurb: 'For a single branch finding its feet.',
    limits: ['10 vehicles', '100 bookings / month', '2,000 API calls / day'],
  },
  {
    id: 'fleet',
    name: 'Fleet',
    blurb: 'For a growing multi-branch operation.',
    limits: ['100 vehicles', '2,000 bookings / month', '20,000 API calls / day'],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    blurb: 'For nationwide fleets with no ceiling.',
    limits: ['Unlimited vehicles', 'Unlimited bookings'],
  },
]

export default function Billing() {
  const { props } = usePage<SharedProps>()
  const company = props.company

  const [billing, setBilling] = useState<Billing | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .get<Billing>('/billing')
      .then((b) => alive && setBilling(b))
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : 'Failed to load billing'))
    return () => {
      alive = false
    }
  }, [])

  // Checkout and portal both hand back a provider URL that we navigate straight
  // to, so on success we keep `busy` set and the buttons stay disabled through
  // the redirect. Only a failure clears it and surfaces the error.
  const redirectAction = useCallback(async (key: string, fn: () => Promise<string>) => {
    setBusy(key)
    setError(null)
    try {
      const url = await fn()
      window.location.href = url
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed')
      setBusy(null)
    }
  }, [])

  const checkout = (plan: PlanId) =>
    redirectAction(`checkout:${plan}`, async () => {
      const res = await api.post<{ url: string; id: string }>('/billing/checkout', { plan })
      return res.url
    })

  const openPortal = () =>
    redirectAction('portal', async () => {
      const res = await api.post<{ url: string }>('/billing/portal')
      return res.url
    })

  const currentPlan = billing?.plan ?? company?.plan ?? 'starter'
  const currentName = PLANS.find((p) => p.id === currentPlan)?.name ?? currentPlan

  return (
    <TenantShell title="Billing" activeHref="/subscription">
      <div className="page-head">
        <div>
          <h1>Billing &amp; subscription</h1>
          <p>
            {company?.name ?? 'Your company'} subscribes to Karimoto. Payments run through MockStripe
            in development and switch to real Stripe the moment a Stripe key is set, using the exact
            same code.
          </p>
        </div>
        <div className="row">
          <span className="badge badge--blue">{currentPlan}</span>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {loadError && billing === null ? (
        <div className="card">
          <div className="card__body empty">{loadError}</div>
        </div>
      ) : billing === null ? (
        <div className="card">
          <div className="card__body empty">Loading…</div>
        </div>
      ) : (
        <div className="stack">
          <div className="stat-grid">
            <Stat label="Current plan" value={currentName} />
            <Stat
              label="Billing customer"
              value={billing.hasCustomer ? 'Active' : 'Not set up'}
              sub={billing.hasCustomer ? 'on the payment provider' : 'start a checkout to subscribe'}
            />
            <Stat label="Provider" value="Stripe" sub="MockStripe in development" />
          </div>

          <div className="card">
            <div className="card__head">
              <div className="card__title">Current plan</div>
              <span className="badge badge--blue">{billing.plan}</span>
            </div>
            <div className="card__body stack" style={{ gap: 14 }}>
              <div className="row row--wrap">
                <span className={`badge ${billing.hasCustomer ? 'badge--green' : 'badge--slate'}`}>
                  <span className="dot" />
                  {billing.hasCustomer ? 'Customer active on provider' : 'No billing customer yet'}
                </span>
                {billing.providerCustomerId && (
                  <span className="mono muted">{billing.providerCustomerId}</span>
                )}
                <span className="spacer" />
                <button className="btn btn--ghost" disabled={busy !== null} onClick={openPortal}>
                  {busy === 'portal' ? 'Opening…' : 'Manage billing'}
                </button>
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 20,
            }}
          >
            {PLANS.map((p) => {
              const isCurrent = p.id === currentPlan
              const key = `checkout:${p.id}`
              const label = isCurrent
                ? 'Current plan'
                : busy === key
                  ? 'Redirecting…'
                  : billing.hasCustomer
                    ? `Switch to ${p.name}`
                    : 'Subscribe'
              return (
                <div className="card" key={p.id}>
                  <div className="card__head">
                    <div className="card__title">{p.name}</div>
                    {isCurrent && <span className="badge badge--green">Current</span>}
                  </div>
                  <div className="card__body stack" style={{ gap: 16 }}>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {p.blurb}
                    </div>
                    <div className="stack" style={{ gap: 10 }}>
                      {p.limits.map((l) => (
                        <div key={l} className="row">
                          <span style={{ color: 'var(--brand)', fontWeight: 700 }}>✓</span>
                          <span style={{ fontSize: 14 }}>{l}</span>
                        </div>
                      ))}
                    </div>
                    <button
                      className="btn btn--primary btn--block"
                      disabled={isCurrent || busy !== null}
                      onClick={() => checkout(p.id)}
                    >
                      {label}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </TenantShell>
  )
}
