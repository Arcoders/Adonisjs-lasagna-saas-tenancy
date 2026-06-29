/**
 * The Deterministic Semantic Diff (RFC §8). The four signals over the graph:
 *
 *   D2-hard  prose naming `Symbol.member(` where member no longer exists (gate-able)
 *   D2-soft  contract-vs-prose token diff, exact missing tokens (advisory)
 *   D3       freshness: a changed symbol whose linked doc was not also touched (advisory)
 *   D4       1-hop static reach of a changed symbol over the public boundary (advisory)
 *
 * All deterministic, no network, no model. D3/D4 use git via `./git.js`, which
 * degrades to empty when history is unavailable.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DocCoverageConfig } from './config.js'
import type { DocGraph, GraphEdge, GraphNode } from './types.js'
import { DOCUMENTABLE_KINDS } from './types.js'
import {
  PARAM_STOPLIST,
  MEMBER_TOKEN_STOPLIST,
  tokenize,
  tokenSet,
  withSynonyms,
  diffTokens,
} from './tokenize.js'
import { changedFiles, lastCommitDate } from './git.js'

/** Strip `#section` / `:fence:NN` to get the doc's repo-relative file path. */
function docFileOf(nodeId: string): string {
  return nodeId.replace(/:fence:\d+$/, '').replace(/#.*$/, '')
}

class DocTextCache {
  private cache = new Map<string, string>()
  constructor(private repoRoot: string) {}
  read(relPath: string): string {
    let text = this.cache.get(relPath)
    if (text === undefined) {
      const abs = join(this.repoRoot, relPath)
      // CRLF -> LF so token/regex matching agrees with the graph builder and is
      // identical on Windows and Linux.
      text = existsSync(abs) ? readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') : ''
      this.cache.set(relPath, text)
    }
    return text
  }
}

function documentableNodes(graph: DocGraph): GraphNode[] {
  return graph.nodes.filter((n) => n.publicPath && DOCUMENTABLE_KINDS.has(n.kind))
}

function incomingIndex(graph: DocGraph): Map<string, GraphEdge[]> {
  const idx = new Map<string, GraphEdge[]>()
  for (const e of graph.edges) {
    const arr = idx.get(e.to) ?? []
    arr.push(e)
    idx.set(e.to, arr)
  }
  return idx
}

/**
 * The contract token set for a symbol: member-name tokens (minus the structural
 * `MEMBER_TOKEN_STOPLIST`) plus non-stoplist param-name tokens. The two stoplists
 * are separate because member names are tokenized then filtered per token, while
 * param names are matched whole against `PARAM_STOPLIST` first.
 */
function contractTokens(node: GraphNode): Set<string> {
  const tokens = new Set<string>()
  for (const m of node.jsdoc?.members ?? [])
    for (const t of tokenize(m)) if (!MEMBER_TOKEN_STOPLIST.has(t)) tokens.add(t)
  for (const p of node.jsdoc?.params ?? []) {
    if (PARAM_STOPLIST.has(p.name.toLowerCase())) continue
    for (const t of tokenize(p.name)) tokens.add(t)
  }
  return tokens
}

// --------------------------------------------------------------------------- D2-soft
export interface D2SoftFinding {
  symbol: string
  doc: string
  missing: string[]
}

export function d2soft(graph: DocGraph, config: DocCoverageConfig): D2SoftFinding[] {
  const docs = new DocTextCache(config.repoRoot)
  const incoming = incomingIndex(graph)
  const findings: D2SoftFinding[] = []
  const seen = new Set<string>()

  for (const node of documentableNodes(graph)) {
    const tokens = contractTokens(node)
    if (tokens.size === 0) continue
    // Only check pages that actually DOCUMENT the symbol (a declared `code:` /
    // `@doc` / `<!-- doc:ref -->` edge), not pages that merely exemplify it in a
    // fence. A page using a symbol as an example is not expected to enumerate its
    // vocabulary; demanding that is the false-positive D2-soft is here to avoid.
    const edges = (incoming.get(node.id) ?? []).filter((e) => e.type === 'documents')
    const pages = new Set(edges.map((e) => docFileOf(e.from)))
    for (const page of pages) {
      const key = `${node.id}|${page}`
      if (seen.has(key)) continue
      seen.add(key)
      const prose = withSynonyms(tokenSet(docs.read(page)), config.synonyms)
      const { missing } = diffTokens(tokens, prose)
      if (missing.length > 0) findings.push({ symbol: node.id, doc: page, missing })
    }
  }
  return findings.sort((a, b) => (a.doc + a.symbol).localeCompare(b.doc + b.symbol))
}

// --------------------------------------------------------------------------- D2-hard
export interface D2HardFinding {
  symbol: string
  member: string
  doc: string
  line: number
}

export function d2hard(graph: DocGraph, config: DocCoverageConfig): D2HardFinding[] {
  const docs = new DocTextCache(config.repoRoot)
  // Index class-like symbols (those with extracted members) by their bare name.
  const byName = new Map<string, GraphNode>()
  for (const n of documentableNodes(graph)) {
    if (!n.jsdoc?.members?.length) continue
    const name = n.publicPath!.split('#')[1]
    if (name && !byName.has(name)) byName.set(name, n)
  }

  const findings: D2HardFinding[] = []
  const docPages = new Set(
    graph.nodes.filter((n) => n.kind === 'doc-page').map((n) => n.internalPath!)
  )
  for (const page of docPages) {
    const text = docs.read(page)
    // `Symbol.member(` is a method call named in prose, the precise dead-method
    // case. Validated against the FULL member set (incl. inherited + static) so
    // a real inherited method like a Job's static `dispatch` is never flagged.
    const re = /\b([A-Z][A-Za-z0-9_]+)\.([a-z][A-Za-z0-9_]*)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const node = byName.get(m[1])
      if (!node) continue
      const member = m[2]
      const known = node.jsdoc!.allMembers?.length ? node.jsdoc!.allMembers : node.jsdoc!.members
      const params = (node.jsdoc!.params ?? []).map((p) => p.name)
      if (known.includes(member) || params.includes(member)) continue
      const line = text.slice(0, m.index).split('\n').length
      findings.push({ symbol: node.id, member, doc: page, line })
    }
  }
  return findings.sort((a, b) =>
    (a.doc + a.symbol + a.member).localeCompare(b.doc + b.symbol + b.member)
  )
}

// --------------------------------------------------------------------------- D3 freshness
export interface D3Finding {
  symbol: string
  doc: string
  reason: string
}

export function d3freshness(
  graph: DocGraph,
  config: DocCoverageConfig,
  opts: { since?: string } = {}
): D3Finding[] {
  const incoming = incomingIndex(graph)
  const findings: D3Finding[] = []
  const seen = new Set<string>()

  const changed = opts.since ? new Set(changedFiles(config.repoRoot, opts.since)) : null

  for (const node of documentableNodes(graph)) {
    if (!node.signatureHash || !node.internalPath) continue
    const edges = (incoming.get(node.id) ?? []).filter(
      (e) => e.type === 'documents' || e.type === 'exemplifies'
    )
    const pages = new Set(edges.map((e) => docFileOf(e.from)))
    if (pages.size === 0) continue

    if (changed) {
      if (!changed.has(node.internalPath)) continue
      for (const page of pages) {
        if (changed.has(page)) continue
        const key = `${node.id}|${page}`
        if (seen.has(key)) continue
        seen.add(key)
        findings.push({
          symbol: node.id,
          doc: page,
          reason: 'signature changed in this range; the doc was not touched',
        })
      }
    } else {
      const symDate = lastCommitDate(config.repoRoot, node.internalPath)
      if (!symDate) continue
      for (const page of pages) {
        const docDate = lastCommitDate(config.repoRoot, page)
        if (!docDate || docDate >= symDate) continue
        const key = `${node.id}|${page}`
        if (seen.has(key)) continue
        seen.add(key)
        findings.push({
          symbol: node.id,
          doc: page,
          reason: 'source modified more recently than the doc',
        })
      }
    }
  }
  return findings.sort((a, b) => (a.doc + a.symbol).localeCompare(b.doc + b.symbol))
}

// --------------------------------------------------------------------------- D4 reach
export interface D4Finding {
  symbol: string
  reaches: string
  /** Hop distance over the public boundary (1 or 2). */
  hops: number
  doc: string
}

/** Default reach depth. The RFC bounds this to 1-2 hops over the public boundary. */
const DEFAULT_MAX_HOPS = 2

/**
 * Depth-bounded static reach (RFC §8, D4). For each changed documented symbol,
 * BFS over a file-level reference graph (symbol A references symbol B when A's
 * source textually names B) up to `maxHops`, and report the reachable documented
 * symbols ranked by distance. Approximate by design and honestly labelled: the
 * reference graph is text-level, and it misses DI / `container.make` edges
 * (RFC §10), which rely on declared anchors instead.
 */
export function d4reach(
  graph: DocGraph,
  config: DocCoverageConfig,
  opts: { since?: string; maxHops?: number } = {}
): D4Finding[] {
  if (!opts.since) return []
  const changed = new Set(changedFiles(config.repoRoot, opts.since))
  if (changed.size === 0) return []
  const maxHops = Math.max(1, Math.min(2, opts.maxHops ?? DEFAULT_MAX_HOPS))

  const incoming = incomingIndex(graph)
  const nodes = documentableNodes(graph)
  const byName = new Map<string, GraphNode>()
  for (const n of nodes) {
    const name = n.publicPath!.split('#')[1]
    if (name && !byName.has(name)) byName.set(name, n)
  }

  // 1-hop adjacency: symbol -> the other public symbols its source file names.
  const docs = new DocTextCache(config.repoRoot)
  const fileNeighbors = new Map<string, Set<GraphNode>>()
  const neighborsOf = (node: GraphNode): Set<GraphNode> => {
    if (!node.internalPath) return new Set()
    let neighbors = fileNeighbors.get(node.internalPath)
    if (neighbors) return neighbors
    neighbors = new Set<GraphNode>()
    const src = docs.read(node.internalPath)
    for (const [name, target] of byName) {
      if (target.internalPath === node.internalPath) continue
      if (new RegExp(`\\b${name}\\b`).test(src)) neighbors.add(target)
    }
    fileNeighbors.set(node.internalPath, neighbors)
    return neighbors
  }

  const findings: D4Finding[] = []
  const seen = new Set<string>()

  for (const start of nodes) {
    if (!start.internalPath || !changed.has(start.internalPath)) continue
    const linkedDocs = [
      ...new Set(
        (incoming.get(start.id) ?? [])
          .filter((e) => e.type === 'documents' || e.type === 'exemplifies')
          .map((e) => docFileOf(e.from))
      ),
    ]
    if (linkedDocs.length === 0) continue

    // BFS over the reference graph, recording the shortest hop distance.
    const distance = new Map<string, number>([[start.id, 0]])
    let frontier: GraphNode[] = [start]
    for (let hop = 1; hop <= maxHops; hop++) {
      const next: GraphNode[] = []
      for (const node of frontier) {
        for (const nb of neighborsOf(node)) {
          if (distance.has(nb.id)) continue
          distance.set(nb.id, hop)
          next.push(nb)
        }
      }
      frontier = next
    }

    for (const [reachedId, hops] of distance) {
      if (hops === 0) continue
      for (const doc of linkedDocs) {
        const key = `${start.id}|${reachedId}|${doc}`
        if (seen.has(key)) continue
        seen.add(key)
        findings.push({ symbol: start.id, reaches: reachedId, hops, doc })
      }
    }
  }
  // Rank by distance first (closest reach is the most relevant), then stable by id.
  return findings.sort(
    (a, b) => a.hops - b.hops || (a.symbol + a.reaches).localeCompare(b.symbol + b.reaches)
  )
}
