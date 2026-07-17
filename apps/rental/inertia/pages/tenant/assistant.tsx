import { useRef, useState } from 'react'
import { usePage } from '@inertiajs/react'
import { TenantShell } from '../../components/shells'
import type { SharedProps } from '../../types'

/** `tools` records the lookups the assistant ran for this turn (WS-AI-11 notices). */
type Turn = { role: 'user' | 'assistant'; content: string; tools?: string[] }

const SUGGESTIONS = [
  'How many bookings do I have right now?',
  'Which vehicles are free next weekend?',
  'Which vehicle is rented the most?',
  'What is our fuel policy?',
]

/**
 * Human labels for the fleet tools (config.ai.tools). The stream carries the tool's
 * name; an unknown one still renders, humanised, so a newly registered tool never
 * shows up blank.
 */
const TOOL_LABELS: Record<string, string> = {
  current_date: 'Checking the date',
  count_bookings: 'Checking bookings',
  count_vehicles: 'Checking the fleet',
  list_available_vehicles: 'Checking availability',
  revenue_summary: 'Checking revenue',
  top_rented_vehicles: 'Ranking the fleet',
}

const toolLabel = (name: string) => TOOL_LABELS[name] ?? name.replace(/_/g, ' ')

export default function Assistant() {
  const { props } = usePage<SharedProps>()
  const principal = props.auth.staff?.email ?? 'staff'

  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // RAG grounding is opt-in: retrieval needs the per-tenant vector store
  // provisioned (pgvector) + embeddings ingested from the Knowledge base. When
  // that isn't wired the gateway returns 400, so we default off and degrade
  // gracefully rather than failing the chat.
  const [useRag, setUseRag] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  const scrollDown = () =>
    requestAnimationFrame(() => {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
    })

  const appendToken = (chunk: string) =>
    setTurns((prev) => {
      const next = prev.slice()
      const last = next[next.length - 1]
      if (last?.role === 'assistant')
        next[next.length - 1] = { ...last, content: last.content + chunk }
      return next
    })

  /** Record a tool the model ran for this turn, so the answer shows what it consulted. */
  const appendToolCall = (name: string) =>
    setTurns((prev) => {
      const next = prev.slice()
      const last = next[next.length - 1]
      if (last?.role === 'assistant')
        next[next.length - 1] = { ...last, tools: [...(last.tools ?? []), name] }
      return next
    })

  /** POST + stream one turn. Returns the HTTP status so the caller can retry. */
  async function streamChat(history: Turn[], retrieve: boolean): Promise<number> {
    // The gateway wants `retrieve` OMITTED for a plain answer, or an object
    // { query } to ground the reply in the tenant's knowledge base — a bare
    // boolean is a 400. Ground the retrieval on the latest user turn.
    const lastUserTurn = [...history].reverse().find((t) => t.role === 'user')?.content ?? ''
    // Operational questions ("how many bookings? which cars are free?") are answered
    // by the fleet tools (config.ai.tools): the model calls them with arguments per
    // question. No pre-folded snapshot — the turns go out as-is.
    const messages = history.map((t) => ({ role: t.role, content: t.content }))
    const res = await fetch('/ai/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'X-Requested-With': 'XMLHttpRequest',
        // config.ai.resolvePrincipal reads this to scope rate-limit + audit.
        'X-Ai-User': principal,
      },
      body: JSON.stringify({
        messages,
        ...(retrieve && lastUserTurn ? { retrieve: { query: lastUserTurn } } : {}),
      }),
    })
    if (!res.ok || !res.body) return res.status
    await consumeSse(res.body, {
      onToken: appendToken,
      onToolCall: appendToolCall,
      onError: (code) => setError(`Stream error: ${code}`),
    })
    return 200
  }

  async function send(text: string) {
    const question = text.trim()
    if (!question || streaming) return
    setError(null)
    setNote(null)
    setInput('')

    // Optimistically show the user turn and an empty assistant turn we stream into.
    const history: Turn[] = [...turns, { role: 'user', content: question }]
    setTurns([...history, { role: 'assistant', content: '' }])
    setStreaming(true)
    scrollDown()

    try {
      let status = await streamChat(history, useRag)
      // Retrieval unavailable (vector store not provisioned) → 400. Degrade to a
      // plain answer instead of failing, and tell the user why once.
      if (status === 400 && useRag) {
        setUseRag(false)
        setNote('Knowledge base grounding is not available yet — answering without retrieval.')
        status = await streamChat(history, false)
      }
      if (status !== 200) throw new Error(`Assistant unavailable (${status}).`)
      scrollDown()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assistant failed')
      // Drop the empty assistant bubble on hard failure.
      setTurns((prev) => (prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev))
    } finally {
      setStreaming(false)
    }
  }

  return (
    <TenantShell title="AI assistant" activeHref="/assistant">
      <div className="page-head">
        <div>
          <h1>Fleet assistant</h1>
          <p>
            Grounded on your fleet and knowledge base (RAG). Streamed over SSE; PII is redacted on
            the way out.
          </p>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {note && <div className="alert alert--success">{note}</div>}

      <div
        className="card"
        style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 230px)' }}
      >
        <div ref={scroller} className="card__body" style={{ flex: 1, overflowY: 'auto' }}>
          {turns.length === 0 ? (
            <div className="empty" style={{ paddingTop: 40 }}>
              <div style={{ fontSize: 40 }}>✦</div>
              <p>Ask about availability, pricing or your policies.</p>
              <div className="row row--wrap" style={{ justifyContent: 'center', marginTop: 12 }}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="btn btn--subtle btn--sm" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              {turns.map((t, i) => (
                <Bubble key={i} turn={t} streaming={streaming && i === turns.length - 1} />
              ))}
            </div>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', padding: 14 }}>
          <label
            className="row muted"
            style={{ fontSize: 13, marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}
          >
            <input
              type="checkbox"
              checked={useRag}
              disabled={streaming}
              onChange={(e) => setUseRag(e.target.checked)}
            />
            Ground answers on the knowledge base (RAG)
          </label>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
          >
            <input
              className="input"
              placeholder="Ask the assistant…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={streaming}
            />
            <button
              className="btn btn--primary"
              type="submit"
              disabled={streaming || !input.trim()}
            >
              {streaming ? 'Streaming…' : 'Send'}
            </button>
          </form>
        </div>
      </div>
    </TenantShell>
  )
}

function Bubble({ turn, streaming }: { turn: Turn; streaming: boolean }) {
  const isUser = turn.role === 'user'
  const tools = turn.tools ?? []
  // While the answer is still empty the tool notice IS the progress indicator, so
  // it replaces the "…" placeholder rather than sitting above it.
  const awaitingTools = streaming && tools.length > 0 && turn.content === ''
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{ maxWidth: '76%' }}>
        {tools.length > 0 && (
          <div
            className="row row--wrap muted"
            style={{ gap: 6, fontSize: 12, marginBottom: 6 }}
            aria-live="polite"
          >
            {tools.map((name, i) => (
              <span key={`${name}-${i}`} className="badge badge--slate">
                🔧 {toolLabel(name)}
                {awaitingTools && i === tools.length - 1 ? '…' : ''}
              </span>
            ))}
          </div>
        )}
        {(turn.content || (streaming && !awaitingTools)) && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 14,
              background: isUser ? 'var(--brand)' : 'var(--surface-2)',
              color: isUser ? '#fff' : 'var(--ink)',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
            }}
          >
            {turn.content || '…'}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Minimal SSE reader for the `/ai/chat` stream. Frames are `id: N\nevent: <e>\n
 * data: <text>\n\n`; `event: token` fragments are the answer text, `event: done`
 * ends it, `event: error` carries a classified code, and `event: tool_call` announces
 * a tool the model is running (name + id only — the satellite never streams the
 * arguments unless the host opts in). Heartbeats (`:` comments) are ignored.
 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onToken: (chunk: string) => void
    onError: (code: string) => void
    onToolCall: (name: string) => void
  }
) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      if (frame.startsWith(':')) continue // heartbeat

      let event = 'token'
      const data: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      const payload = data.join('\n')

      if (event === 'done') return
      if (event === 'error') {
        handlers.onError(payload || 'unknown')
        return
      }
      // A tool_call frame is a NOTICE that the model is looking something up, not
      // answer text — its payload is `{name, id}` JSON. Route it to its own handler;
      // appending it as a token would paint raw JSON into the bubble.
      if (event === 'tool_call') {
        try {
          const call = JSON.parse(payload) as { name?: string }
          if (call.name) handlers.onToolCall(call.name)
        } catch {
          /* a notice we cannot parse is not worth failing the stream over */
        }
        continue
      }
      if (payload) handlers.onToken(payload)
    }
  }
}
