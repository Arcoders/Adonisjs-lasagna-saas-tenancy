import { useEffect, useState } from 'react'
import { usePage } from '@inertiajs/react'
import { TenantShell, Stat } from '../../components/shells'
import { api } from '../../lib/api'
import type { Company, SharedProps } from '../../types'

type Vehicle = { id: string; status: string; plate?: string }
type Booking = { id: string; status: string }

// Mirrors config/multitenancy.ts `plans.definitions` — illustrative quota bars
// for the browser (the authoritative limits live server-side in QuotaService).
const PLAN_LIMITS: Record<string, { vehicles: number; bookings: number }> = {
  starter: { vehicles: 10, bookings: 100 },
  fleet: { vehicles: 100, bookings: 2000 },
  enterprise: { vehicles: 100000, bookings: 100000 },
}

export default function TenantDashboard() {
  const { props } = usePage<SharedProps>()
  const company = props.company as Company

  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null)
  const [bookings, setBookings] = useState<Booking[] | null>(null)
  const [billing, setBilling] = useState<{ plan: string; hasCustomer: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      api.get<{ vehicles: Vehicle[] }>('/vehicles').catch(() => ({ vehicles: [] })),
      api.get<{ bookings: Booking[] }>('/bookings').catch(() => ({ bookings: [] })),
      api
        .get<{ plan: string; hasCustomer: boolean }>('/billing')
        .catch(() => ({ plan: company.plan, hasCustomer: false })),
    ])
      .then(([v, b, bill]) => {
        if (!alive) return
        setVehicles(v.vehicles)
        setBookings(b.bookings)
        setBilling(bill)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Failed to load'))
    return () => {
      alive = false
    }
  }, [company.plan])

  const fleet = countBy(vehicles, (v) => v.status)
  const book = countBy(bookings, (b) => b.status)
  const limits = PLAN_LIMITS[company.plan] ?? PLAN_LIMITS.starter
  const fleetTotal = vehicles?.length ?? 0
  const bookingsTotal = bookings?.length ?? 0
  const activeRentals = book['active'] ?? 0

  return (
    <TenantShell title="Dashboard">
      <div className="page-head">
        <div>
          <h1>{company.name}</h1>
          <p>Today at a glance — fleet, rentals and subscription.</p>
        </div>
        <div className="row">
          <span className="badge badge--blue">{company.plan}</span>
          {company.maintenance && <span className="badge badge--amber">maintenance</span>}
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <Stat label="Fleet size" value={fleetTotal} sub={`${fleet['available'] ?? 0} available now`} />
        <Stat label="Active rentals" value={activeRentals} sub={`${book['confirmed'] ?? 0} upcoming`} />
        <Stat label="Bookings" value={bookingsTotal} sub={`${book['completed'] ?? 0} completed`} />
        <Stat
          label="In maintenance"
          value={fleet['maintenance'] ?? 0}
          sub={`${fleet['retired'] ?? 0} retired`}
        />
      </div>

      <div className="stack" style={{ gap: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
          <div className="card">
            <div className="card__head">
              <div className="card__title">Fleet status</div>
            </div>
            <div className="card__body">
              <Breakdown
                loading={vehicles === null}
                rows={[
                  ['Available', fleet['available'] ?? 0, 'badge--green'],
                  ['Rented', fleet['rented'] ?? 0, 'badge--blue'],
                  ['Maintenance', fleet['maintenance'] ?? 0, 'badge--amber'],
                  ['Retired', fleet['retired'] ?? 0, 'badge--slate'],
                ]}
              />
            </div>
          </div>

          <div className="card">
            <div className="card__head">
              <div className="card__title">Bookings by status</div>
            </div>
            <div className="card__body">
              <Breakdown
                loading={bookings === null}
                rows={[
                  ['Quote', book['quote'] ?? 0, 'badge--slate'],
                  ['Confirmed', book['confirmed'] ?? 0, 'badge--blue'],
                  ['Active', book['active'] ?? 0, 'badge--green'],
                  ['Completed', book['completed'] ?? 0, 'badge--slate'],
                  ['Cancelled', (book['cancelled'] ?? 0) + (book['no_show'] ?? 0), 'badge--red'],
                ]}
              />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card__head">
            <div className="card__title">Subscription & usage</div>
            <span className="badge badge--slate">{billing?.plan ?? company.plan} plan</span>
          </div>
          <div className="card__body stack" style={{ gap: 18 }}>
            <QuotaBar label="Fleet" used={fleetTotal} limit={limits.vehicles} unit="vehicles" />
            <QuotaBar label="Bookings" used={bookingsTotal} limit={limits.bookings} unit="this month" />
            <div className="muted" style={{ fontSize: 13 }}>
              {billing?.hasCustomer
                ? 'Billing customer active on the payment provider.'
                : 'No billing customer yet — start a checkout to subscribe.'}
            </div>
          </div>
        </div>
      </div>
    </TenantShell>
  )
}

/* ─── bits ───────────────────────────────────────────────────────────────── */

function Breakdown({
  rows,
  loading,
}: {
  rows: [string, number, string][]
  loading: boolean
}) {
  if (loading) return <div className="muted">Loading…</div>
  return (
    <div className="stack" style={{ gap: 10 }}>
      {rows.map(([label, n, tone]) => (
        <div key={label} className="row">
          <span className={`badge ${tone}`} style={{ minWidth: 96, justifyContent: 'center' }}>
            {label}
          </span>
          <span className="spacer" />
          <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
        </div>
      ))}
    </div>
  )
}

function QuotaBar({
  label,
  used,
  limit,
  unit,
}: {
  label: string
  used: number
  limit: number
  unit: string
}) {
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100))
  const tone = pct >= 90 ? 'var(--red-500)' : pct >= 70 ? 'var(--amber-500)' : 'var(--brand)'
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 13 }}>
          {used} / {limit === 100000 ? '∞' : limit} {unit}
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 999,
          background: 'var(--surface-2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: tone, transition: 'width .3s' }} />
      </div>
    </div>
  )
}

function countBy<T>(rows: T[] | null, key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  if (!rows) return out
  for (const r of rows) {
    const k = key(r)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}
