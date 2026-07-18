import { createElement } from 'react'
import type { ReactNode } from 'react'

/**
 * Rich renderer for a fleet-assistant answer (WS-AI-11 UI).
 *
 * The assistant streams plain text over SSE, and that text is markdown. Dumping it
 * raw (the old `white-space: pre-wrap` bubble) showed the reader the markdown SOURCE
 * — literal `**`, `##`, `| … |`. This turns the same stream into real UI: headings,
 * bold, lists and GFM tables render, and two host-defined fenced blocks the model is
 * taught to emit (see `lib/assistant_prompt`) become live components:
 *
 *   ```stat   → a KPI row of stat tiles     (JSON array of { label, value, sub? })
 *   ```chart  → a bar or line chart          (JSON { type, title, unit?, data:[{label,value}] })
 *
 * Everything is parsed from the SAME token stream — the satellite never ships tool
 * RESULTS to the client (only `tool_call` notices), so there is nothing to wire on the
 * server: the model narrates and emits the block, the client renders it.
 *
 * Streaming-safe by construction. The text arrives token by token, so a fenced block
 * is routinely half-written: an unterminated ```chart / ```stat renders a pulsing
 * placeholder (never raw JSON), and only pops into a chart/tiles once the closing
 * fence lands and the JSON parses. Malformed-but-closed falls back to a code block.
 *
 * No markdown dependency: a compact block+inline parser handles the subset the model
 * uses. It renders through React elements (never `dangerouslySetInnerHTML`), so the
 * answer text cannot inject markup.
 */
export function AssistantMessage({ content }: { content: string }) {
  const segments = splitSegments(content)
  return (
    <div className="md">
      {segments.map((seg, i) =>
        seg.kind === 'fence' ? (
          <FenceBlock key={i} seg={seg} />
        ) : (
          <Markdown key={i} text={seg.text} />
        )
      )}
    </div>
  )
}

// ─── Segmentation: fenced blocks vs markdown text ────────────────────────────

type Segment =
  | { kind: 'fence'; lang: string; body: string; closed: boolean }
  | { kind: 'text'; text: string }

/**
 * Split the answer into an ordered run of fenced code blocks and the markdown text
 * between them. A fence opens on a line of ```` ``` ```` (+ optional info string) and
 * closes on a bare ```` ``` ````; an unclosed trailing fence (mid-stream) is kept with
 * `closed: false` so the caller can show a placeholder rather than the raw body.
 */
function splitSegments(src: string): Segment[] {
  const lines = src.split('\n')
  const out: Segment[] = []
  let buf: string[] = []
  const flush = () => {
    if (buf.some((l) => l.trim() !== '')) out.push({ kind: 'text', text: buf.join('\n') })
    buf = []
  }
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? ''
    const open = /^\s*```(.*)$/.exec(line)
    if (open) {
      flush()
      const lang = (open[1] ?? '').trim().toLowerCase()
      const body: string[] = []
      i += 1
      let closed = false
      for (; i < lines.length; i += 1) {
        if (/^\s*```\s*$/.test(lines[i] ?? '')) {
          closed = true
          i += 1
          break
        }
        body.push(lines[i] ?? '')
      }
      out.push({ kind: 'fence', lang, body: body.join('\n'), closed })
      continue
    }
    buf.push(line)
    i += 1
  }
  flush()
  return out
}

function FenceBlock({ seg }: { seg: Extract<Segment, { kind: 'fence' }> }) {
  if (seg.lang === 'chart') {
    const spec = seg.closed ? parseChart(seg.body) : null
    if (spec) return <ChartFigure spec={spec} />
    return seg.closed ? <CodeBlock body={seg.body} /> : <Pending label="Rendering chart…" />
  }
  if (seg.lang === 'stat') {
    const items = seg.closed ? parseStats(seg.body) : null
    if (items) return <StatTiles items={items} />
    return seg.closed ? <CodeBlock body={seg.body} /> : <Pending label="Preparing summary…" />
  }
  return <CodeBlock body={seg.body} />
}

// ─── Fenced payloads ─────────────────────────────────────────────────────────

type ChartSpec = {
  type: 'bar' | 'line'
  title: string
  unit: string
  data: { label: string; value: number }[]
}

/** Parse a ```chart payload, coercing/validating defensively; null if unusable. */
function parseChart(body: string): ChartSpec | null {
  try {
    const raw = JSON.parse(body) as Record<string, unknown>
    const rows = Array.isArray(raw.data) ? raw.data : []
    const data = rows
      .map((d) => {
        const row = (d ?? {}) as Record<string, unknown>
        return { label: String(row.label ?? ''), value: Number(row.value) }
      })
      .filter((d) => d.label !== '' && Number.isFinite(d.value))
      .slice(0, 12)
    if (data.length === 0) return null
    return {
      type: raw.type === 'line' ? 'line' : 'bar',
      title: String(raw.title ?? ''),
      unit: String(raw.unit ?? ''),
      data,
    }
  } catch {
    return null
  }
}

type StatItem = { label: string; value: string; sub: string | null }

/** Parse a ```stat payload (array, or `{ items: [...] }`); null if empty/unusable. */
function parseStats(body: string): StatItem[] | null {
  try {
    const raw = JSON.parse(body) as unknown
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as Record<string, unknown>)?.items)
        ? ((raw as Record<string, unknown>).items as unknown[])
        : []
    const items = list
      .map((s) => {
        const row = (s ?? {}) as Record<string, unknown>
        return {
          label: String(row.label ?? ''),
          value: String(row.value ?? ''),
          sub: row.sub != null ? String(row.sub) : null,
        }
      })
      .filter((s) => s.label !== '' || s.value !== '')
      .slice(0, 6)
    return items.length ? items : null
  } catch {
    return null
  }
}

// ─── Figures ─────────────────────────────────────────────────────────────────

function StatTiles({ items }: { items: StatItem[] }) {
  return (
    <div className="stat-grid ai-stats">
      {items.map((s, i) => (
        <div className="stat" key={i}>
          <div className="stat__label">{s.label}</div>
          <div className="stat__value">{s.value}</div>
          {s.sub && <div className="stat__sub">{s.sub}</div>}
        </div>
      ))}
    </div>
  )
}

function ChartFigure({ spec }: { spec: ChartSpec }) {
  return (
    <figure className="chart">
      {(spec.title || spec.unit) && (
        <figcaption className="chart__title">
          <span>{spec.title}</span>
          {spec.unit && <span className="chart__unit">{spec.unit}</span>}
        </figcaption>
      )}
      {spec.type === 'line' ? <LineChart spec={spec} /> : <BarChart spec={spec} />}
    </figure>
  )
}

/**
 * Horizontal bars, in plain HTML. Category comparisons and rankings often carry long
 * labels (a vehicle's make/model/plate), which read far better down the left than
 * rotated under columns. Single series, so one hue (`--brand`) carries magnitude — the
 * sequential default — with the value at each bar's tip (a `title` gives the hover).
 */
function BarChart({ spec }: { spec: ChartSpec }) {
  const max = Math.max(...spec.data.map((d) => d.value), 0)
  return (
    <div className="bars">
      {spec.data.map((d, i) => {
        const pct = max > 0 ? Math.max((d.value / max) * 100, 1.5) : 0
        return (
          <div className="bars__row" key={i} title={`${d.label}: ${fmt(d.value)}`}>
            <div className="bars__label">{d.label}</div>
            <div className="bars__track">
              <div className="bars__fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="bars__value">{fmt(d.value)}</div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A single-series line over an ordered axis (a genuine time trend). 2px line, round
 * caps, an end-marker ringed in the surface colour so it clears the line, two-to-three
 * recessive gridlines, and the final value labelled directly. Scales with its
 * container via the viewBox; text stays in ink tokens, never the data colour.
 */
function LineChart({ spec }: { spec: ChartSpec }) {
  const W = 640
  const H = 200
  const padL = 6
  const padR = 44
  const padT = 14
  const padB = 26
  const data = spec.data
  const top = niceTop(Math.max(...data.map((d) => d.value), 0))
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const x = (i: number) =>
    padL + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW)
  const y = (v: number) => padT + plotH - (top > 0 ? (v / top) * plotH : 0)
  const points = data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ')
  const ticks = [0, top / 2, top]
  const lastIndex = data.length - 1
  const last = data[lastIndex]

  return (
    <svg
      className="linechart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={spec.title || 'trend chart'}
    >
      {ticks.map((t, i) => (
        <g key={`t${i}`}>
          <line className="chart__grid" x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} />
          <text className="chart__axis" x={W - padR + 6} y={y(t) + 3} textAnchor="start">
            {fmt(Math.round(t))}
          </text>
        </g>
      ))}
      <polyline className="chart__line" points={points} />
      {data.map((d, i) => (
        <g key={`d${i}`}>
          <circle className="chart__dotring" cx={x(i)} cy={y(d.value)} r={5} />
          <circle className="chart__dot" cx={x(i)} cy={y(d.value)} r={3}>
            <title>{`${d.label}: ${fmt(d.value)}`}</title>
          </circle>
        </g>
      ))}
      {last && (
        <text className="chart__endval" x={x(lastIndex)} y={y(last.value) - 10} textAnchor="middle">
          {fmt(last.value)}
        </text>
      )}
      {data.map((d, i) => (
        <text key={`x${i}`} className="chart__axis" x={x(i)} y={H - 8} textAnchor="middle">
          {d.label}
        </text>
      ))}
    </svg>
  )
}

// ─── Markdown (the non-fenced text) ──────────────────────────────────────────

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'hr' }
  | { t: 'quote'; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[] }
  | { t: 'table'; header: string[]; rows: string[][] }
  | { t: 'p'; text: string }

function Markdown({ text }: { text: string }) {
  return (
    <>
      {parseBlocks(text).map((block, i) => (
        <MdBlock key={i} block={block} />
      ))}
    </>
  )
}

const HEADING = /^\s{0,3}(#{1,4})\s+(.*)$/
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const UL = /^\s{0,3}[-*+]\s+/
const OL = /^\s{0,3}\d+\.\s+/
const QUOTE = /^\s{0,3}>\s?/

/** Group lines into block-level markdown nodes. Tolerant of partial input. */
function parseBlocks(src: string): Block[] {
  const lines = src.split('\n')
  const blocks: Block[] = []
  const n = lines.length
  let i = 0
  while (i < n) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ t: 'h', level: (heading[1] ?? '#').length, text: (heading[2] ?? '').trim() })
      i += 1
      continue
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' })
      i += 1
      continue
    }
    if (line.includes('|') && isTableSep(lines[i + 1] ?? '')) {
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < n && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(splitRow(lines[i] ?? ''))
        i += 1
      }
      blocks.push({ t: 'table', header, rows })
      continue
    }
    if (QUOTE.test(line)) {
      const q: string[] = []
      while (i < n && QUOTE.test(lines[i] ?? '')) {
        q.push((lines[i] ?? '').replace(QUOTE, ''))
        i += 1
      }
      blocks.push({ t: 'quote', text: q.join(' ') })
      continue
    }
    if (UL.test(line)) {
      const items: string[] = []
      while (i < n && UL.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(UL, ''))
        i += 1
      }
      blocks.push({ t: 'ul', items })
      continue
    }
    if (OL.test(line)) {
      const items: string[] = []
      while (i < n && OL.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(OL, ''))
        i += 1
      }
      blocks.push({ t: 'ol', items })
      continue
    }
    const para: string[] = []
    while (i < n) {
      const l = lines[i] ?? ''
      if (
        l.trim() === '' ||
        HEADING.test(l) ||
        HR.test(l) ||
        UL.test(l) ||
        OL.test(l) ||
        QUOTE.test(l) ||
        (l.includes('|') && isTableSep(lines[i + 1] ?? ''))
      ) {
        break
      }
      para.push(l)
      i += 1
    }
    if (para.length) blocks.push({ t: 'p', text: para.join(' ') })
    else i += 1
  }
  return blocks
}

/** A GFM table separator row: only pipes, dashes, colons and spaces, with both a pipe and a dash. */
function isTableSep(line: string): boolean {
  const t = line.trim()
  return t !== '' && /^[\s|:-]+$/.test(t) && t.includes('|') && t.includes('-')
}

function splitRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

function MdBlock({ block }: { block: Block }) {
  switch (block.t) {
    case 'h':
      return createElement(
        `h${Math.min(6, block.level + 1)}`,
        { className: 'md-h' },
        inline(block.text)
      )
    case 'hr':
      return <hr className="md-hr" />
    case 'quote':
      return <blockquote className="md-quote">{inline(block.text)}</blockquote>
    case 'ul':
      return (
        <ul className="md-ul">
          {block.items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol className="md-ol">
          {block.items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ol>
      )
    case 'table':
      return (
        <div className="table-wrap">
          <table className="table md-table">
            <thead>
              <tr>
                {block.header.map((h, i) => (
                  <th key={i}>{inline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {block.header.map((_, ci) => (
                    <td key={ci}>{inline(row[ci] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'p':
      return <p className="md-p">{inline(block.text)}</p>
  }
}

// Inline: **bold** / __bold__, *em* / _em_, `code`, [text](url). Not nested — good
// enough for chat prose, and it never emits raw HTML.
const INLINE =
  /(\*\*(.+?)\*\*)|(__(.+?)__)|(`([^`]+)`)|(\*(.+?)\*)|(_(.+?)_)|(\[([^\]]+)\]\(([^)\s]+)\))/g

function inline(src: string): ReactNode {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(src))) {
    if (m.index > last) nodes.push(src.slice(last, m.index))
    if (m[2] != null) nodes.push(<strong key={key++}>{m[2]}</strong>)
    else if (m[4] != null) nodes.push(<strong key={key++}>{m[4]}</strong>)
    else if (m[6] != null)
      nodes.push(
        <code key={key++} className="md-code">
          {m[6]}
        </code>
      )
    else if (m[8] != null) nodes.push(<em key={key++}>{m[8]}</em>)
    else if (m[10] != null) nodes.push(<em key={key++}>{m[10]}</em>)
    else if (m[12] != null)
      nodes.push(
        <a key={key++} href={safeHref(m[13] ?? '')} target="_blank" rel="noreferrer">
          {m[12]}
        </a>
      )
    last = INLINE.lastIndex
  }
  if (last < src.length) nodes.push(src.slice(last))
  return nodes
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function CodeBlock({ body }: { body: string }) {
  return (
    <pre className="md-pre">
      <code>{body}</code>
    </pre>
  )
}

function Pending({ label }: { label: string }) {
  return (
    <div className="chart-pending" aria-live="polite">
      <span className="chart-pending__dot" />
      {label}
    </div>
  )
}

/** Round a max up to a clean axis top (1/2/5 × 10ⁿ). */
function niceTop(max: number): number {
  if (max <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  const n = max / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

/** Thousands-grouped; up to two decimals for a non-integer. */
function fmt(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** Only allow safe URL schemes; anything else (e.g. javascript:) collapses to '#'. */
function safeHref(url: string): string {
  return /^(https?:\/\/|mailto:|\/|#)/i.test(url) ? url : '#'
}
