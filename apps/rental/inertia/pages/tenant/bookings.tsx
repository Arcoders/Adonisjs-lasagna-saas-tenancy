import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { usePage } from '@inertiajs/react'
import { TenantShell, Stat } from '../../components/shells'
import { api, ApiError } from '../../lib/api'
import { useLiveBoard, type BoardStatus } from '../../lib/socket'
import type { SharedProps } from '../../types'

/* A booking as returned by the tenant domain API (`GET /bookings`). Money is
 * carried as integer *santimat* (MAD × 100) end to end, so divide by 100 to
 * display: a `total` of 97200 renders as "972.00 MAD". */
type BookingStatus = 'quote' | 'confirmed' | 'active' | 'completed' | 'cancelled' | 'no_show'

type PriceBreakdown = {
  total?: number
  currency?: string
  days?: number
  lineItems?: any[]
}

type Booking = {
  id: string
  status: BookingStatus
  pickupAt: string
  dropoffAt: string
  priceBreakdown: PriceBreakdown | null
  depositHeld: number | null
  customer?: { id: string; fullName: string } | null
  vehicle?: { id: string; plate: string; makeName: string; modelName: string } | null
}

/* Customers come back tidy; vehicles come from the raw `_read` replica → snake_case. */
type Customer = { id: string; fullName: string }
type VehicleRow = {
  id: string
  plate: string
  make_name: string
  model_name: string
  status: string
}

/* The invoice shape the VAT endpoint hands back varies; read it defensively. */
type Invoice = {
  id?: string
  number?: string
  invoiceNumber?: string
  total?: number
  currency?: string
}

const BOOKING_TONE: Record<BookingStatus, string> = {
  quote: 'badge--slate',
  confirmed: 'badge--blue',
  active: 'badge--green',
  completed: 'badge--slate',
  cancelled: 'badge--red',
  no_show: 'badge--red',
}

type RunMsg = string | ((result: any) => string)
type RunFn = (
  key: string,
  fn: () => Promise<unknown>,
  msg: RunMsg,
  reload: () => Promise<unknown>
) => Promise<void>
type ActFn = (key: string, fn: () => Promise<unknown>, msg: RunMsg) => Promise<void>

export default function Bookings() {
  const [bookings, setBookings] = useState<Booking[] | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [vehicles, setVehicles] = useState<VehicleRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const loadBookings = useCallback(async () => {
    try {
      const res = await api.get<{ bookings: Booking[] }>('/bookings')
      setBookings(res.bookings)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load bookings')
      setBookings([])
    }
  }, [])

  const loadRefs = useCallback(async () => {
    const [cus, veh] = await Promise.all([
      api.get<{ customers: Customer[] }>('/customers').catch(() => ({ customers: [] })),
      api.get<{ vehicles: VehicleRow[] }>('/vehicles').catch(() => ({ vehicles: [] })),
    ])
    setCustomers(cus.customers)
    setVehicles(veh.vehicles)
  }, [])

  useEffect(() => {
    loadBookings()
    loadRefs()
  }, [loadBookings, loadRefs])

  // Live board: when the server broadcasts a committed booking write to this
  // company's room, refetch the list so a change made anywhere (another agent,
  // another tab, the API) lands here without a manual refresh.
  const { props } = usePage<SharedProps>()
  const boardStatus = useLiveBoard(props.company?.id, (name) => {
    if (name === 'booking:changed') loadBookings()
  })

  const run = useCallback<RunFn>(async (key, fn, msg, reload) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      const result = await fn()
      setNotice(typeof msg === 'function' ? msg(result) : msg)
      await reload()
    } catch (e) {
      // 422 (overlap/pricing/bad transition) and 429 (quota) both carry a
      // human message on the ApiError — surface it verbatim.
      setError(e instanceof ApiError ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }, [])

  const act = useCallback<ActFn>(
    (key, fn, msg) => run(key, fn, msg, loadBookings),
    [run, loadBookings]
  )

  const counts = useMemo(() => {
    const c = { total: 0, active: 0, confirmed: 0, completed: 0 }
    for (const b of bookings ?? []) {
      c.total++
      if (b.status in c) (c as any)[b.status]++
    }
    return c
  }, [bookings])

  return (
    <TenantShell title="Bookings" activeHref="/reservations">
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <p>overlap-checked, priced with 20% VAT, counted against your monthly quota.</p>
        </div>
        <button className="btn btn--primary" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? 'Close' : '+ New booking'}
        </button>
      </div>

      {notice && <div className="alert alert--success">{notice}</div>}
      {error && <div className="alert alert--error">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <Stat label="Bookings" value={counts.total} />
        <Stat label="Active" value={counts.active} sub="on the road" />
        <Stat label="Confirmed" value={counts.confirmed} sub="awaiting pickup" />
        <Stat label="Completed" value={counts.completed} sub="ready to invoice" />
      </div>

      {showAdd && (
        <AddBooking
          customers={customers}
          vehicles={vehicles}
          busy={busy === 'add-booking'}
          run={run}
          onDone={() => {
            loadBookings()
            loadRefs()
            setShowAdd(false)
          }}
        />
      )}

      <div className="card">
        <div className="card__head">
          <div className="card__title">All bookings</div>
          <div className="row" style={{ gap: 10 }}>
            <LiveDot status={boardStatus} />
            <button className="btn btn--subtle btn--sm" onClick={loadBookings}>
              Refresh
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Vehicle</th>
                <th>Dates</th>
                <th>Status</th>
                <th>Total</th>
                <th style={{ textAlign: 'right' }}>Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {bookings === null && (
                <tr>
                  <td colSpan={6} className="empty">
                    Loading bookings…
                  </td>
                </tr>
              )}
              {bookings?.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No bookings yet. Create the first one.
                  </td>
                </tr>
              )}
              {bookings?.map((b) => (
                <tr key={b.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{b.customer?.fullName ?? '—'}</div>
                  </td>
                  <td>
                    {b.vehicle ? (
                      <>
                        <div className="mono">{b.vehicle.plate}</div>
                        <div className="muted" style={{ fontSize: 12.5 }}>
                          {b.vehicle.makeName} {b.vehicle.modelName}
                        </div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    <div>
                      {formatShort(b.pickupAt)}
                      <span style={{ opacity: 0.5 }}> → </span>
                      {formatShort(b.dropoffAt)}
                    </div>
                    {b.priceBreakdown?.days != null && (
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {b.priceBreakdown.days} day{b.priceBreakdown.days === 1 ? '' : 's'}
                      </div>
                    )}
                  </td>
                  <td>
                    <BookingBadge status={b.status} />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {formatMoney(b.priceBreakdown?.total, b.priceBreakdown?.currency)}
                    </div>
                    {b.depositHeld != null && b.depositHeld > 0 && (
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {formatMoney(b.depositHeld, b.priceBreakdown?.currency)} deposit
                      </div>
                    )}
                  </td>
                  <td>
                    <BookingActions booking={b} busy={busy} act={act} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </TenantShell>
  )
}

/* ─── Per-row lifecycle actions (drive the booking state machine) ─────────── */

function BookingActions({
  booking: b,
  busy,
  act,
}: {
  booking: Booking
  busy: string | null
  act: ActFn
}) {
  const disabled = busy !== null
  const btns: {
    key: string
    label: string
    run: () => Promise<unknown>
    msg: RunMsg
    danger?: boolean
  }[] = []

  if (b.status === 'quote') {
    btns.push({
      key: `${b.id}:confirm`,
      label: 'Confirm',
      run: () => api.post(`/bookings/${b.id}/confirm`),
      msg: 'Booking confirmed.',
    })
    btns.push({
      key: `${b.id}:cancel`,
      label: 'Cancel',
      danger: true,
      run: () => api.post(`/bookings/${b.id}/cancel`),
      msg: 'Booking cancelled.',
    })
  }
  if (b.status === 'confirmed') {
    btns.push({
      key: `${b.id}:activate`,
      label: 'Activate',
      run: () => api.post(`/bookings/${b.id}/activate`),
      msg: 'Booking activated — vehicle is out.',
    })
    btns.push({
      key: `${b.id}:cancel`,
      label: 'Cancel',
      danger: true,
      run: () => api.post(`/bookings/${b.id}/cancel`),
      msg: 'Booking cancelled.',
    })
  }
  if (b.status === 'active') {
    btns.push({
      key: `${b.id}:complete`,
      label: 'Complete',
      run: () => api.post(`/bookings/${b.id}/complete`),
      msg: 'Booking completed — vehicle returned.',
    })
  }
  if (b.status === 'completed') {
    btns.push({
      key: `${b.id}:invoice`,
      label: 'Invoice',
      run: () => api.post<{ invoice?: Invoice }>(`/bookings/${b.id}/invoice`),
      msg: (r: { invoice?: Invoice } | null) => invoiceNotice(r?.invoice),
    })
  }

  if (btns.length === 0) {
    return (
      <span className="muted" style={{ fontSize: 13 }}>
        —
      </span>
    )
  }

  return (
    <div className="row row--wrap" style={{ justifyContent: 'flex-end' }}>
      {btns.map((btn) => (
        <button
          key={btn.key}
          className={`btn btn--sm ${btn.danger ? 'btn--danger' : 'btn--ghost'}`}
          disabled={disabled}
          onClick={() => act(btn.key, btn.run, btn.msg)}
        >
          {busy === btn.key ? '…' : btn.label}
        </button>
      ))}
    </div>
  )
}

/* ─── New booking form ───────────────────────────────────────────────────── */

function AddBooking({
  customers,
  vehicles,
  busy,
  run,
  onDone,
}: {
  customers: Customer[]
  vehicles: VehicleRow[]
  busy: boolean
  run: RunFn
  onDone: () => void
}) {
  const [customerId, setCustomerId] = useState('')
  const [vehicleId, setVehicleId] = useState('')
  const [pickupAt, setPickupAt] = useState('')
  const [dropoffAt, setDropoffAt] = useState('')
  const [extras, setExtras] = useState('')
  const [confirm, setConfirm] = useState(false)

  const extrasList = extras
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const canSubmit = customerId && vehicleId && pickupAt && dropoffAt

  const submit = () =>
    run(
      'add-booking',
      () =>
        api.post('/bookings', {
          customerId,
          vehicleId,
          // datetime-local yields a local wall-clock value; normalise to ISO 8601.
          pickupAt: new Date(pickupAt).toISOString(),
          dropoffAt: new Date(dropoffAt).toISOString(),
          ...(extrasList.length ? { extras: extrasList } : {}),
          confirm,
        }),
      confirm ? 'Booking created and confirmed.' : 'Booking created as a quote.',
      async () => onDone()
    )

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card__head">
        <div className="card__title">New booking</div>
      </div>
      <div className="card__body">
        {(customers.length === 0 || vehicles.length === 0) && (
          <div className="alert alert--error">
            {customers.length === 0 && 'Add a customer first — a booking needs one. '}
            {vehicles.length === 0 && 'Add a vehicle first (Fleet) — a booking needs one.'}
          </div>
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
            gap: 14,
          }}
        >
          <Field label="Customer">
            <select
              className="select"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              <option value="">Select…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Vehicle">
            <select
              className="select"
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
            >
              <option value="">Select…</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plate} — {v.make_name} {v.model_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pickup">
            <input
              className="input"
              type="datetime-local"
              value={pickupAt}
              onChange={(e) => setPickupAt(e.target.value)}
            />
          </Field>
          <Field label="Drop-off">
            <input
              className="input"
              type="datetime-local"
              value={dropoffAt}
              onChange={(e) => setDropoffAt(e.target.value)}
            />
          </Field>
        </div>

        <div style={{ marginTop: 14 }}>
          <Field label="Extras (optional, comma-separated)">
            <input
              className="input"
              value={extras}
              onChange={(e) => setExtras(e.target.value)}
              placeholder="gps, child_seat, additional_driver"
            />
          </Field>
        </div>

        <label className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 14, marginTop: 4 }}>
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Confirm immediately (skip the quote step)
        </label>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn--primary" disabled={!canSubmit || busy} onClick={submit}>
            {busy ? 'Creating…' : confirm ? 'Create & confirm' : 'Create quote'}
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            The server checks the vehicle is free for the window and prices it with 20% VAT.
          </span>
        </div>
      </div>
    </div>
  )
}

/* ─── bits ───────────────────────────────────────────────────────────────── */

function BookingBadge({ status }: { status: BookingStatus }) {
  return (
    <span className={`badge ${BOOKING_TONE[status] ?? 'badge--slate'}`}>
      <span className="dot" />
      {status.replace('_', ' ')}
    </span>
  )
}

/** WebSocket connection indicator for the live board. */
function LiveDot({ status }: { status: BoardStatus }) {
  const tone =
    status === 'live' ? 'badge--green' : status === 'connecting' ? 'badge--blue' : 'badge--slate'
  const label = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'
  return (
    <span className={`badge ${tone}`} title="Live updates over WebSockets">
      <span className="dot" />
      {label}
    </span>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label className="field__label">{label}</label>
      {children}
    </div>
  )
}

/* ─── helpers ────────────────────────────────────────────────────────────── */

/** Santimat (MAD × 100) → a display string like "972.00 MAD". */
function formatMoney(santimat: number | null | undefined, currency?: string): string {
  if (santimat == null) return '—'
  return `${(santimat / 100).toFixed(2)} ${currency ?? 'MAD'}`
}

function formatShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function invoiceNotice(inv?: Invoice | null): string {
  if (!inv) return 'VAT invoice issued.'
  const num = inv.number ?? inv.invoiceNumber ?? inv.id
  const total = inv.total != null ? formatMoney(inv.total, inv.currency) : null
  if (num && total) return `Invoice ${num} issued for ${total}.`
  if (num) return `Invoice ${num} issued.`
  if (total) return `VAT invoice issued for ${total}.`
  return 'VAT invoice issued.'
}
