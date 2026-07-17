import { useCallback, useEffect, useState } from 'react'
import { usePage } from '@inertiajs/react'
import { TenantShell, Stat } from '../../components/shells'
import { api, ApiError } from '../../lib/api'
import type { SharedProps } from '../../types'

/* Policy / FAQ documents that ground the AI fleet assistant via RAG. A row is
 * just stored text until its body is ingested into the per-tenant vector store —
 * only then can the assistant retrieve it. */
type Doc = {
  id: string
  title: string
  body: string
  source: string
  createdAt: string
}

export default function Knowledge() {
  const { props } = usePage<SharedProps>()
  // config.ai.resolvePrincipal reads X-Ai-User to scope the ingest call.
  const principal = props.auth.staff?.email ?? 'staff'

  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [ingested, setIngested] = useState<Set<string>>(new Set())

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [source, setSource] = useState('')

  const loadDocs = useCallback(async () => {
    try {
      const res = await api.get<{ docs: Doc[] }>('/fleet-docs')
      setDocs(res.docs)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load documents')
      setDocs([])
    }
  }, [])

  useEffect(() => {
    loadDocs()
  }, [loadDocs])

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
        setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Action failed')
      } finally {
        setBusy(null)
      }
    },
    []
  )

  const canSubmit = title.trim() && body.trim()

  const addDoc = () =>
    run(
      'add-doc',
      async () => {
        const trimmed = source.trim()
        await api.post('/fleet-docs', {
          title: title.trim(),
          body,
          ...(trimmed ? { source: trimmed } : {}),
        })
        // Clear only after the upsert succeeds so a failure keeps the draft.
        setTitle('')
        setBody('')
        setSource('')
      },
      `Saved “${title.trim()}”.`,
      loadDocs
    )

  const ingest = (doc: Doc) =>
    run(
      `ingest:${doc.id}`,
      async () => {
        // The shared `api` helper can't add per-call headers, so this one call
        // is a raw fetch that carries X-Ai-User.
        const res = await fetch('/ai/embed', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Ai-User': principal,
          },
          body: JSON.stringify({ source: doc.source, input: doc.body }),
        })
        if (!res.ok) throw new Error(`Embed failed (${res.status})`)
        setIngested((prev) => new Set(prev).add(doc.id))
      },
      `Embedded “${doc.title}” into the assistant.`,
      async () => {}
    )

  const total = docs?.length ?? 0

  return (
    <TenantShell title="Knowledge base" activeHref="/knowledge">
      <div className="page-head">
        <div>
          <h1>Knowledge base</h1>
          <p>
            These documents ground the AI assistant (RAG). Ingest a document to make its
            contents retrievable.
          </p>
        </div>
      </div>

      {notice && <div className="alert alert--success">{notice}</div>}
      {error && <div className="alert alert--error">{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <Stat label="Documents" value={total} sub={`${ingested.size} indexed this session`} />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card__head">
          <div className="card__title">Add document</div>
        </div>
        <div className="card__body">
          <div className="field">
            <label className="field__label">Title</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Cancellation policy"
            />
          </div>
          <div className="field">
            <label className="field__label">Body</label>
            <textarea
              className="textarea"
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Bookings cancelled at least 48 hours before pick-up are fully refunded…"
            />
          </div>
          <div className="field">
            <label className="field__label">
              Source <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              className="input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="cancellation-policy"
            />
            <div className="muted" style={{ fontSize: 12.5 }}>
              Leave blank to auto-generate; reuse a source to update an existing document.
            </div>
          </div>
          <button className="btn btn--primary" disabled={!canSubmit || busy === 'add-doc'} onClick={addDoc}>
            {busy === 'add-doc' ? 'Saving…' : 'Add document'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div className="card__title">Documents</div>
          <button className="btn btn--subtle btn--sm" onClick={loadDocs}>
            Refresh
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Source</th>
                <th>Snippet</th>
                <th>Created</th>
                <th style={{ textAlign: 'right' }}>Assistant</th>
              </tr>
            </thead>
            <tbody>
              {docs === null && (
                <tr>
                  <td colSpan={5} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {docs?.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No documents yet. Add a policy or FAQ to ground the assistant.
                  </td>
                </tr>
              )}
              {docs?.map((doc) => (
                <tr key={doc.id}>
                  <td style={{ fontWeight: 600 }}>{doc.title}</td>
                  <td>
                    <span className="badge badge--slate mono">{doc.source}</span>
                  </td>
                  <td>
                    <span className="muted truncate" style={{ display: 'inline-block' }}>
                      {snippet(doc.body)}
                    </span>
                  </td>
                  <td className="muted">{formatDate(doc.createdAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      {ingested.has(doc.id) && (
                        <span className="badge badge--green">
                          <span className="dot" />
                          indexed
                        </span>
                      )}
                      <button
                        className="btn btn--subtle btn--sm"
                        disabled={busy !== null}
                        onClick={() => ingest(doc)}
                      >
                        {busy === `ingest:${doc.id}` ? 'Ingesting…' : 'Ingest to assistant'}
                      </button>
                    </div>
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

/* ─── bits ───────────────────────────────────────────────────────────────── */

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}
