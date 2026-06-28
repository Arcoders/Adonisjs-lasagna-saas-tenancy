/**
 * `--init-anchors` bootstrap (RFC §B4). Proposes front-matter `code:` blocks for
 * each doc page from the edges already derived automatically (fence imports +
 * resolved GitHub URLs), so the day-1 graph is not empty and the strongest,
 * gate-trusted `declared:manual` edges can be seeded by review rather than typed
 * from scratch. Output is a paste-ready proposal, never an in-place edit.
 */
import type { DocGraph } from './types.js'

export function initAnchors(graph: DocGraph): string {
  // doc-page -> set of derived symbol targets.
  const byPage = new Map<string, Set<string>>()
  for (const e of graph.edges) {
    if (e.provenance !== 'derived:auto') continue
    if (e.type !== 'exemplifies' && e.type !== 'references') continue
    const page = e.from.replace(/:fence:\d+$/, '').replace(/#.*$/, '')
    if (!byPage.has(page)) byPage.set(page, new Set())
    byPage.get(page)!.add(e.to)
  }

  const pages = [...byPage.keys()].sort()
  if (pages.length === 0)
    return 'No derived edges to propose. Add a fence import or a GitHub URL first.'

  const out: string[] = []
  out.push(`# Proposed front-matter code: anchors for ${pages.length} page(s).`)
  out.push(`# Review and paste the block into each page's front-matter to promote`)
  out.push(`# these derived edges to gate-trusted declared:manual edges.`)
  out.push('')
  for (const page of pages) {
    const targets = [...byPage.get(page)!].sort()
    out.push(`## ${page}`)
    out.push('code:')
    for (const t of targets) out.push(`  - "${t}"`)
    out.push('')
  }
  return out.join('\n')
}
