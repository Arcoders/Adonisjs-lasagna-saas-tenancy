/**
 * The coverage metric (RFC §6). For every public symbol of a documentable kind,
 * classify it as explained, exemplified-only, or uncovered, with a quality floor
 * so a fence-only or backtick-only mention is not counted as real explanation.
 *
 *   explained         a `documents` edge (declared / front-matter / GitHub URL),
 *                     OR a JSDoc description of >= EXPLAINED_JSDOC_WORDS words.
 *   exemplified-only  only fence (`exemplifies`) or inferred-mention edges.
 *   uncovered         no edge and no substantial JSDoc.
 *
 * Coverage is the backstop signal: a symbol with neither prose nor JSDoc shows
 * up here even when D2/D3 stay silent, so a code-doc gap is never hidden.
 */
import type { DocGraph, GraphEdge, GraphNode, NodeKind } from './types.js'
import { DOCUMENTABLE_KINDS } from './types.js'

const EXPLAINED_JSDOC_WORDS = 20

export type CoverageStatus = 'explained' | 'exemplified' | 'uncovered'

export interface CoverageRow {
  id: string
  kind: NodeKind
  package: string | null
  status: CoverageStatus
  /** Why it landed in that bucket, for the report. */
  reason: string
}

export interface CoverageReport {
  total: number
  explained: number
  exemplified: number
  uncovered: number
  /** Percentages rounded to whole numbers, summing to ~100. */
  pct: { explained: number; exemplified: number; uncovered: number }
  byKind: Record<
    string,
    { total: number; explained: number; exemplified: number; uncovered: number }
  >
  rows: CoverageRow[]
}

function classify(
  node: GraphNode,
  incoming: GraphEdge[]
): { status: CoverageStatus; reason: string } {
  const hasProseEdge = incoming.some(
    (e) => e.type === 'documents' || (e.type === 'references' && e.provenance === 'derived:auto')
  )
  const jsdocWords = node.jsdoc?.descriptionWordCount ?? 0
  if (hasProseEdge) return { status: 'explained', reason: 'documents/reference edge to prose' }
  if (jsdocWords >= EXPLAINED_JSDOC_WORDS) {
    return { status: 'explained', reason: `JSDoc description (${jsdocWords} words)` }
  }

  const hasExample = incoming.some(
    (e) => e.type === 'exemplifies' || (e.type === 'references' && e.provenance === 'inferred')
  )
  if (hasExample) return { status: 'exemplified', reason: 'fence or mention only' }

  return { status: 'uncovered', reason: 'no doc edge, no substantial JSDoc' }
}

export function computeCoverage(graph: DocGraph): CoverageReport {
  const incomingByTo = new Map<string, GraphEdge[]>()
  for (const e of graph.edges) {
    const arr = incomingByTo.get(e.to) ?? []
    arr.push(e)
    incomingByTo.set(e.to, arr)
  }

  const rows: CoverageRow[] = []
  for (const node of graph.nodes) {
    if (!node.publicPath || !DOCUMENTABLE_KINDS.has(node.kind)) continue
    const incoming = incomingByTo.get(node.id) ?? []
    const { status, reason } = classify(node, incoming)
    rows.push({ id: node.id, kind: node.kind, package: node.package, status, reason })
  }
  rows.sort((a, b) => a.id.localeCompare(b.id))

  const counts = { explained: 0, exemplified: 0, uncovered: 0 }
  const byKind: CoverageReport['byKind'] = {}
  for (const r of rows) {
    counts[r.status]++
    const k = (byKind[r.kind] ??= { total: 0, explained: 0, exemplified: 0, uncovered: 0 })
    k.total++
    k[r.status]++
  }

  const total = rows.length
  const pctOf = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 100))

  return {
    total,
    ...counts,
    pct: {
      explained: pctOf(counts.explained),
      exemplified: pctOf(counts.exemplified),
      uncovered: pctOf(counts.uncovered),
    },
    byKind,
    rows,
  }
}
