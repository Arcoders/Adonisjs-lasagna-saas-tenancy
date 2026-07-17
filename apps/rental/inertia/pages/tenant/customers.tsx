import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { TenantShell, Stat } from '../../components/shells'
import { api, ApiError } from '../../lib/api'

/*
 * Customer PII lives crypto-shredded in the tenant schema: cin / driverLicense /
 * passport are encrypted at rest (Law 09-08 / GDPR) and returned decrypted only
 * in the authenticated list. `cin` also carries a blind index, so exact lookups
 * work without ever decrypting the column. Erasure destroys the per-row key —
 * after that a read fails closed with 410 Gone.
 */
type Customer = {
  id: string
  fullName: string
  email: string | null
  phone: string | null
  cin: string | null
  driverLicense: string | null
  passport: string | null
  address: string | null
  nationality: string | null
}

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [erased, setErased] = useState<Set<string>>(new Set())

  const [cinQuery, setCinQuery] = useState('')
  const [matches, setMatches] = useState<Customer[] | null>(null)

  const loadCustomers = useCallback(async () => {
    try {
      const res = await api.get<{ customers: Customer[] }>('/customers')
      setCustomers(res.customers)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load customers')
      setCustomers([])
    }
  }, [])

  useEffect(() => {
    loadCustomers()
  }, [loadCustomers])

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
    const list = customers ?? []
    return {
      total: list.length,
      withCin: list.filter((c) => !!c.cin).length,
    }
  }, [customers])

  /* Blind-index exact search by CIN — matches encrypted rows without decrypting. */
  const searchByCin = useCallback(async () => {
    const cin = cinQuery.trim()
    if (!cin) return
    setBusy('search')
    setError(null)
    setNotice(null)
    try {
      const res = await api.post<{ matches: Customer[] }>('/customers/search', { cin })
      setMatches(res.matches)
      setNotice(
        `Blind-index lookup: ${res.matches.length} match${res.matches.length === 1 ? '' : 'es'} for that CIN.`
      )
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Search failed')
      setMatches([])
    } finally {
      setBusy(null)
    }
  }, [cinQuery])

  /*
   * Crypto-shred: destroy the row key, then prove the read now fails closed by
   * asserting GET /customers/:id returns 410 Gone. Governance can refuse (403).
   */
  const shred = useCallback(async (c: Customer) => {
    if (!confirm(`Permanently erase ${c.fullName}'s PII? This is irreversible (crypto-shred).`)) return
    setBusy(`${c.id}:shred`)
    setError(null)
    setNotice(null)
    try {
      await api.post(`/customers/${c.id}/shred`)
      let failsClosed = false
      try {
        await api.get(`/customers/${c.id}`)
      } catch (e) {
        if (e instanceof ApiError && e.status === 410) failsClosed = true
      }
      setErased((prev) => {
        const next = new Set(prev)
        next.add(c.id)
        return next
      })
      setNotice(
        failsClosed
          ? `${c.fullName}'s PII erased — the ciphertext is unrecoverable and reads now return 410 Gone.`
          : `${c.fullName}'s PII erased (crypto-shred).`
      )
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setError(e.message || 'Erasure refused by governance policy.')
      } else {
        setError(e instanceof ApiError ? e.message : 'Shred failed')
      }
    } finally {
      setBusy(null)
    }
  }, [])

  return (
    <TenantShell title="Customers" activeHref="/renters">
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <p>
            Renter records with encrypted PII — CIN, driver licence and passport are stored
            crypto-shredded and stay blind-index searchable.
          </p>
        </div>
        <div className="row">
          <button className="btn btn--primary" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? 'Close' : '+ New customer'}
          </button>
        </div>
      </div>

      {notice && <div className="alert alert--success">{notice}</div>}
      {error && <div className="alert alert--error">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <Stat label="Customers" value={counts.total} />
        <Stat label="With CIN on file" value={counts.withCin} sub="blind-index searchable" />
        <Stat label="Erased this session" value={erased.size} sub="crypto-shredded" />
      </div>

      {showAdd && (
        <AddCustomer
          busy={busy === 'add-customer'}
          run={run}
          onDone={() => {
            loadCustomers()
            setShowAdd(false)
          }}
        />
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card__head">
          <div className="card__title">Search by CIN</div>
        </div>
        <div className="card__body">
          <div className="row row--wrap" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ marginBottom: 0, flex: '1 1 220px' }}>
              <label className="field__label">National ID (CIN)</label>
              <input
                className="input"
                value={cinQuery}
                onChange={(e) => setCinQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') searchByCin()
                }}
                placeholder="AB123456"
              />
            </div>
            <button
              className="btn btn--ghost"
              disabled={!cinQuery.trim() || busy === 'search'}
              onClick={searchByCin}
            >
              {busy === 'search' ? 'Searching…' : 'Search'}
            </button>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            Exact match against the CIN blind index — the encrypted column is never decrypted to search.
          </div>

          {matches !== null && (
            <div className="stack" style={{ gap: 10, marginTop: 16 }}>
              {matches.length === 0 ? (
                <div className="muted">No customer matches that CIN.</div>
              ) : (
                matches.map((m) => (
                  <div key={m.id} className="row">
                    <span className="badge badge--blue">match</span>
                    <strong>{m.fullName}</strong>
                    <span className="spacer" />
                    <span className="mono">{m.cin ?? '—'}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div className="card__title">Customers</div>
          <button className="btn btn--subtle btn--sm" onClick={loadCustomers}>
            Refresh
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>CIN</th>
                <th>Nationality</th>
                <th style={{ textAlign: 'right' }}>Erasure</th>
              </tr>
            </thead>
            <tbody>
              {customers === null && (
                <tr>
                  <td colSpan={6} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {customers?.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No customers yet. Add one to get started.
                  </td>
                </tr>
              )}
              {customers?.map((c) => {
                const gone = erased.has(c.id)
                return (
                  <tr key={c.id} style={gone ? { opacity: 0.6 } : undefined}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{c.fullName}</div>
                      {!gone && (c.driverLicense || c.passport) && (
                        <div className="muted" style={{ fontSize: 12.5 }}>
                          {[
                            c.driverLicense && `licence ${c.driverLicense}`,
                            c.passport && `passport ${c.passport}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="muted">{c.email ?? '—'}</td>
                    <td className="muted">{c.phone ?? '—'}</td>
                    <td className="mono">
                      {gone ? <span className="muted">unrecoverable</span> : c.cin ?? '—'}
                    </td>
                    <td className="muted">{c.nationality ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {gone ? (
                        <span className="badge badge--red">
                          <span className="dot" />
                          Erased — 410 Gone
                        </span>
                      ) : (
                        <button
                          className="btn btn--danger btn--sm"
                          disabled={busy !== null}
                          onClick={() => shred(c)}
                        >
                          {busy === `${c.id}:shred` ? 'Erasing…' : 'Erase (shred)'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </TenantShell>
  )
}

/* ─── Add customer ───────────────────────────────────────────────────────── */

function AddCustomer({
  busy,
  onDone,
  run,
}: {
  busy: boolean
  onDone: () => void
  run: (k: string, fn: () => Promise<unknown>, m: string, r: () => Promise<unknown>) => Promise<void>
}) {
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    cin: '',
    driverLicense: '',
    passport: '',
    nationality: '',
    address: '',
    dateOfBirth: '',
  })

  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }))
  const canSubmit = form.fullName.trim().length > 0

  const submit = () =>
    run(
      'add-customer',
      () =>
        api.post('/customers', {
          fullName: form.fullName.trim(),
          ...(form.email ? { email: form.email } : {}),
          ...(form.phone ? { phone: form.phone } : {}),
          ...(form.cin ? { cin: form.cin } : {}),
          ...(form.driverLicense ? { driverLicense: form.driverLicense } : {}),
          ...(form.passport ? { passport: form.passport } : {}),
          ...(form.nationality ? { nationality: form.nationality } : {}),
          ...(form.address ? { address: form.address } : {}),
          ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
        }),
      `${form.fullName.trim()} added.`,
      async () => onDone()
    )

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card__head">
        <div className="card__title">Add a customer</div>
      </div>
      <div className="card__body">
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}
        >
          <Field label="Full name">
            <input
              className="input"
              value={form.fullName}
              onChange={(e) => set('fullName')(e.target.value)}
              placeholder="Yasmine El Amrani"
            />
          </Field>
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => set('email')(e.target.value)}
              placeholder="yasmine@example.ma"
            />
          </Field>
          <Field label="Phone">
            <input
              className="input"
              value={form.phone}
              onChange={(e) => set('phone')(e.target.value)}
              placeholder="+212 6 12 34 56 78"
            />
          </Field>
          <Field label="CIN (national ID)">
            <input
              className="input"
              value={form.cin}
              onChange={(e) => set('cin')(e.target.value)}
              placeholder="AB123456"
            />
          </Field>
          <Field label="Driver licence">
            <input
              className="input"
              value={form.driverLicense}
              onChange={(e) => set('driverLicense')(e.target.value)}
              placeholder="1234567"
            />
          </Field>
          <Field label="Passport">
            <input
              className="input"
              value={form.passport}
              onChange={(e) => set('passport')(e.target.value)}
              placeholder="MA0000000"
            />
          </Field>
          <Field label="Nationality">
            <input
              className="input"
              value={form.nationality}
              onChange={(e) => set('nationality')(e.target.value)}
              placeholder="Moroccan"
            />
          </Field>
          <Field label="Date of birth">
            <input
              className="input"
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => set('dateOfBirth')(e.target.value)}
            />
          </Field>
          <Field label="Address">
            <textarea
              className="textarea"
              rows={2}
              value={form.address}
              onChange={(e) => set('address')(e.target.value)}
              placeholder="12 Rue de la Liberté, Casablanca"
            />
          </Field>
        </div>

        <div className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
          CIN, driver licence and passport are encrypted at rest and blind-index searchable.
        </div>

        <div style={{ marginTop: 16 }}>
          <button className="btn btn--primary" disabled={!canSubmit || busy} onClick={submit}>
            {busy ? 'Saving…' : 'Add customer'}
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
