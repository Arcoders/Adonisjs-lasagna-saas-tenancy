import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { TenantShell, Stat } from '../../components/shells'
import { api, ApiError } from '../../lib/api'

/* Vehicles come from the raw `_read` replica query → snake_case columns. */
type Vehicle = {
  id: string
  plate: string
  make_name: string
  model_name: string
  year: number
  status: 'available' | 'rented' | 'maintenance' | 'retired'
  mileage: number
  fuel: string
  transmission: string
  category_id: string | null
}
type Make = { id: number; name: string; models: { id: number; name: string; bodyType: string }[] }
type Category = { id: string; name: string; code: string; dailyRate: number; depositAmount: number }
type Location = { id: string; name: string; city: string; type: string }

const STATUSES: Vehicle['status'][] = ['available', 'rented', 'maintenance', 'retired']
const STATUS_TONE: Record<string, string> = {
  available: 'badge--green',
  rented: 'badge--blue',
  maintenance: 'badge--amber',
  retired: 'badge--slate',
}

export default function Fleet() {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null)
  const [makes, setMakes] = useState<Make[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showSetup, setShowSetup] = useState(false)

  const loadVehicles = useCallback(async () => {
    try {
      const res = await api.get<{ vehicles: Vehicle[] }>('/vehicles')
      setVehicles(res.vehicles)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vehicles')
      setVehicles([])
    }
  }, [])

  const loadRefs = useCallback(async () => {
    const [cat, loc, cats] = await Promise.all([
      api.get<{ makes: Make[] }>('/catalog').catch(() => ({ makes: [] })),
      api.get<{ locations: Location[] }>('/locations').catch(() => ({ locations: [] })),
      api.get<{ categories: Category[] }>('/categories').catch(() => ({ categories: [] })),
    ])
    setMakes(cat.makes)
    setLocations(loc.locations)
    setCategories(cats.categories)
  }, [])

  useEffect(() => {
    loadVehicles()
    loadRefs()
  }, [loadVehicles, loadRefs])

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, msg: string, reload: () => Promise<unknown>) => {
      setBusy(key)
      setError(null)
      setNotice(null)
      try {
        await fn()
        setNotice(msg)
        await reload()
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Action failed')
      } finally {
        setBusy(null)
      }
    },
    []
  )

  const counts = useMemo(() => {
    const c = { total: 0, available: 0, rented: 0, maintenance: 0 }
    for (const v of vehicles ?? []) {
      c.total++
      if (v.status in c) (c as any)[v.status]++
    }
    return c
  }, [vehicles])

  const setStatus = (v: Vehicle, status: string) =>
    run(
      `${v.id}:status`,
      () => api.post(`/vehicles/${v.id}/status`, { status }),
      `${v.plate} → ${status}.`,
      loadVehicles
    )

  return (
    <TenantShell title="Fleet" activeHref="/fleet">
      <div className="page-head">
        <div>
          <h1>Fleet</h1>
          <p>Vehicles drawn from the shared catalogue; new vehicles count against your plan quota.</p>
        </div>
        <div className="row">
          <button className="btn btn--ghost" onClick={() => setShowSetup((v) => !v)}>
            Branches & categories
          </button>
          <button className="btn btn--primary" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? 'Close' : '+ Add vehicle'}
          </button>
        </div>
      </div>

      {notice && <div className="alert alert--success">{notice}</div>}
      {error && <div className="alert alert--error">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <Stat label="Vehicles" value={counts.total} />
        <Stat label="Available" value={counts.available} />
        <Stat label="Rented" value={counts.rented} />
        <Stat label="Maintenance" value={counts.maintenance} />
      </div>

      {showSetup && (
        <SetupPanel
          categories={categories}
          locations={locations}
          busy={busy}
          run={run}
          reload={loadRefs}
        />
      )}

      {showAdd && (
        <AddVehicle
          makes={makes}
          categories={categories}
          locations={locations}
          busy={busy === 'add-vehicle'}
          onDone={() => {
            loadVehicles()
            setShowAdd(false)
          }}
          run={run}
        />
      )}

      <div className="card">
        <div className="card__head">
          <div className="card__title">Vehicles</div>
          <button className="btn btn--subtle btn--sm" onClick={loadVehicles}>
            Refresh
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Plate</th>
                <th>Vehicle</th>
                <th>Year</th>
                <th>Mileage</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Set status</th>
              </tr>
            </thead>
            <tbody>
              {vehicles === null && (
                <tr>
                  <td colSpan={6} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {vehicles?.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No vehicles yet. Add one to get started.
                  </td>
                </tr>
              )}
              {vehicles?.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.plate}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {v.make_name} {v.model_name}
                    </div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {v.fuel} · {v.transmission}
                    </div>
                  </td>
                  <td className="muted">{v.year}</td>
                  <td className="muted">{v.mileage.toLocaleString()} km</td>
                  <td>
                    <span className={`badge ${STATUS_TONE[v.status]}`}>
                      <span className="dot" />
                      {v.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <select
                      className="select"
                      style={{ width: 150, display: 'inline-block' }}
                      value={v.status}
                      disabled={busy !== null}
                      onChange={(e) => setStatus(v, e.target.value)}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
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

/* ─── Add vehicle ────────────────────────────────────────────────────────── */

function AddVehicle({
  makes,
  categories,
  locations,
  busy,
  onDone,
  run,
}: {
  makes: Make[]
  categories: Category[]
  locations: Location[]
  busy: boolean
  onDone: () => void
  run: (k: string, fn: () => Promise<unknown>, m: string, r: () => Promise<unknown>) => Promise<void>
}) {
  const [plate, setPlate] = useState('')
  const [makeId, setMakeId] = useState<number | ''>('')
  const [modelId, setModelId] = useState<number | ''>('')
  const [year, setYear] = useState(2024)
  const [categoryId, setCategoryId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [fuel, setFuel] = useState('petrol')
  const [transmission, setTransmission] = useState('manual')

  const models = makes.find((m) => m.id === makeId)?.models ?? []
  const canSubmit = plate && makeId && modelId && categoryId

  const submit = () =>
    run(
      'add-vehicle',
      () =>
        api.post('/vehicles', {
          plate,
          makeId: Number(makeId),
          modelId: Number(modelId),
          year,
          categoryId,
          ...(locationId ? { locationId } : {}),
          fuel,
          transmission,
        }),
      `${plate} added to the fleet.`,
      async () => onDone()
    )

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card__head">
        <div className="card__title">Add a vehicle</div>
      </div>
      <div className="card__body">
        {categories.length === 0 && (
          <div className="alert alert--error">
            Add a category first (Branches & categories) — a vehicle needs one.
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14 }}>
          <Field label="Plate">
            <input className="input" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="12345-A-6" />
          </Field>
          <Field label="Make">
            <select
              className="select"
              value={makeId}
              onChange={(e) => {
                setMakeId(e.target.value ? Number(e.target.value) : '')
                setModelId('')
              }}
            >
              <option value="">Select…</option>
              {makes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select
              className="select"
              value={modelId}
              disabled={!makeId}
              onChange={(e) => setModelId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">Select…</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Year">
            <input
              className="input"
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            />
          </Field>
          <Field label="Category">
            <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Select…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Branch">
            <select className="select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">—</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fuel">
            <select className="select" value={fuel} onChange={(e) => setFuel(e.target.value)}>
              {['petrol', 'diesel', 'hybrid', 'electric'].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </Field>
          <Field label="Transmission">
            <select className="select" value={transmission} onChange={(e) => setTransmission(e.target.value)}>
              {['manual', 'automatic'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <button className="btn btn--primary" disabled={!canSubmit || busy} onClick={submit}>
            {busy ? 'Adding…' : 'Add vehicle'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── Branches & categories setup ────────────────────────────────────────── */

function SetupPanel({
  categories,
  locations,
  busy,
  run,
  reload,
}: {
  categories: Category[]
  locations: Location[]
  busy: string | null
  run: (k: string, fn: () => Promise<unknown>, m: string, r: () => Promise<unknown>) => Promise<void>
  reload: () => Promise<unknown>
}) {
  const [cat, setCat] = useState({ name: '', code: 'economy', dailyRate: 250, depositAmount: 3000 })
  const [loc, setLoc] = useState({ name: '', city: '', type: 'city' })

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 20, marginBottom: 20 }}>
      <div className="card">
        <div className="card__head">
          <div className="card__title">Categories</div>
        </div>
        <div className="card__body stack" style={{ gap: 12 }}>
          {categories.map((c) => (
            <div key={c.id} className="row">
              <span className="badge badge--slate">{c.code}</span>
              <strong>{c.name}</strong>
              <span className="spacer" />
              <span className="muted">{c.dailyRate} MAD/day</span>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <input className="input" placeholder="Name" value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} />
            <select className="select" value={cat.code} onChange={(e) => setCat({ ...cat, code: e.target.value })}>
              {['economy', 'compact', 'suv', 'luxury', 'van'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input className="input" type="number" placeholder="Daily rate" value={cat.dailyRate} onChange={(e) => setCat({ ...cat, dailyRate: Number(e.target.value) })} />
            <input className="input" type="number" placeholder="Deposit" value={cat.depositAmount} onChange={(e) => setCat({ ...cat, depositAmount: Number(e.target.value) })} />
          </div>
          <button
            className="btn btn--subtle btn--sm"
            disabled={!cat.name || busy === 'add-cat'}
            onClick={() =>
              run('add-cat', () => api.post('/categories', cat), `${cat.name} category added.`, reload).then(() =>
                setCat({ name: '', code: 'economy', dailyRate: 250, depositAmount: 3000 })
              )
            }
          >
            Add category
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div className="card__title">Branches</div>
        </div>
        <div className="card__body stack" style={{ gap: 12 }}>
          {locations.map((l) => (
            <div key={l.id} className="row">
              <span className="badge badge--slate">{l.type}</span>
              <strong>{l.name}</strong>
              <span className="spacer" />
              <span className="muted">{l.city}</span>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <input className="input" placeholder="Name" value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} />
            <input className="input" placeholder="City" value={loc.city} onChange={(e) => setLoc({ ...loc, city: e.target.value })} />
            <select className="select" value={loc.type} onChange={(e) => setLoc({ ...loc, type: e.target.value })}>
              {['airport', 'city', 'depot'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <button
            className="btn btn--subtle btn--sm"
            disabled={!loc.name || !loc.city || busy === 'add-loc'}
            onClick={() =>
              run('add-loc', () => api.post('/locations', loc), `${loc.name} branch added.`, reload).then(() =>
                setLoc({ name: '', city: '', type: 'city' })
              )
            }
          >
            Add branch
          </button>
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
