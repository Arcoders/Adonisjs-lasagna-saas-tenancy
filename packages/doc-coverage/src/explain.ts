/**
 * `--explain <symbol>` and `--why <doc#section>` (RFC DX section). Print the
 * edges + provenance + source locations behind a node, so a finding is always
 * debuggable: "why is this page linked to this symbol?"
 */
import type { DocGraph, GraphEdge } from './types.js'

function fmtEdge(e: GraphEdge, dir: 'in' | 'out'): string {
  const other = dir === 'in' ? e.from : e.to
  const at = dir === 'in' ? e.at.from : e.at.to
  return `  ${e.provenance.padEnd(15)} ${e.type.padEnd(12)} ${dir === 'in' ? '<-' : '->'} ${other}${at ? `  (${at})` : ''}`
}

export function explainSymbol(graph: DocGraph, query: string): string {
  const node =
    graph.nodes.find((n) => n.id === query) ??
    graph.nodes.find((n) => n.publicPath && n.publicPath.endsWith(`#${query}`)) ??
    graph.nodes.find((n) => n.id.includes(query))
  if (!node) return `No symbol matching "${query}".`

  const out: string[] = []
  out.push(`${node.id}`)
  out.push(`  kind:     ${node.kind}`)
  out.push(
    `  source:   ${node.internalPath ?? '(none)'}${node.sourceRange ? `:${node.sourceRange.line}` : ''}`
  )
  if (node.signatureHash) out.push(`  contract: ${node.signatureHash.slice(0, 16)}`)
  if (node.jsdoc) {
    out.push(`  members:  ${node.jsdoc.members.join(', ') || '(none)'}`)
    out.push(`  throws:   ${node.jsdoc.throws.join(', ') || '(none)'}`)
  }
  const incoming = graph.edges.filter((e) => e.to === node.id)
  out.push(`  documented by ${incoming.length} edge(s):`)
  for (const e of incoming) out.push(fmtEdge(e, 'in'))
  return out.join('\n')
}

export function whyDoc(graph: DocGraph, query: string): string {
  const node =
    graph.nodes.find((n) => n.id === query) ?? graph.nodes.find((n) => n.id.endsWith(query))
  if (!node) return `No doc node matching "${query}".`

  const out: string[] = []
  out.push(`${node.id}`)
  out.push(`  kind:   ${node.kind}`)
  out.push(`  source: ${node.internalPath ?? '(none)'}`)
  const outgoing = graph.edges.filter((e) => e.from === node.id)
  out.push(`  links to ${outgoing.length} node(s):`)
  for (const e of outgoing) out.push(fmtEdge(e, 'out'))
  return out.join('\n')
}
