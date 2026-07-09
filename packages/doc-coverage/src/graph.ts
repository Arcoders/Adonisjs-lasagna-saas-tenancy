/**
 * The graph builder (RFC §3, Deliverable B1). Creates one TS program over every
 * public barrel of every configured package, extracts code nodes (with barrel
 * resolution + contract hashes), then extracts doc nodes + edges and stitches in
 * the declared `@doc` anchors. Output is a deterministic, sorted `DocGraph`.
 */
import ts from 'typescript'
import type { DocCoverageConfig } from './config.js'
import { rel } from './config.js'
import { buildCodeNodes } from './symbols.js'
import { buildDocNodes } from './docs.js'
import { slugify } from './docs.js'
import type { DocGraph, GraphEdge, GraphNode } from './types.js'
import { SCHEMA_VERSION } from './types.js'

const PROGRAM_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  useUnknownInCatchVariables: false,
  skipLibCheck: true,
  noEmit: true,
}

export interface BuildResult {
  graph: DocGraph
  /** Non-fatal diagnostics (e.g. a barrel that did not resolve). */
  warnings: string[]
  /** Repo-relative pages that opted out of D3 via `<!-- doc:freshness-ignore -->`. */
  freshnessIgnore: string[]
}

/**
 * Normalize an `@doc` target (a repo-relative page path with an optional
 * `#section`, written with or without the `.md` suffix) to the doc-section node
 * id used by the docs walker: the `.md` path plus the slugified fragment.
 */
function normalizeDocTarget(target: string): string {
  const [path = '', frag] = target.split('#')
  const mdPath = path.endsWith('.md') ? path : `${path}.md`
  return frag ? `${mdPath}#${slugify(frag)}` : mdPath
}

export function buildGraph(config: DocCoverageConfig): BuildResult {
  const warnings: string[] = []

  const allBarrels = config.packages.flatMap((p) => p.barrels)
  const rootNames = [...new Set(allBarrels.map((b) => b.indexFile))]
  const program = ts.createProgram(rootNames, PROGRAM_OPTIONS)
  const checker = program.getTypeChecker()

  const { nodes: codeNodes, docAnchors } = buildCodeNodes(
    program,
    checker,
    allBarrels,
    config.repoRoot
  )

  // Indexes for edge resolution.
  const knownPublicPaths = new Set(codeNodes.map((n) => n.publicPath!).filter(Boolean))
  const nameIndex = new Map<string, string[]>()
  const fileIndex = new Map<string, string[]>()
  for (const n of codeNodes) {
    if (!n.publicPath) continue
    const name = n.publicPath.split('#')[1]
    if (name) {
      const arr = nameIndex.get(name) ?? []
      arr.push(n.publicPath)
      nameIndex.set(name, arr)
    }
    if (n.internalPath) {
      const arr = fileIndex.get(n.internalPath) ?? []
      arr.push(n.publicPath)
      fileIndex.set(n.internalPath, arr)
    }
  }

  const docNodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const freshnessIgnore: string[] = []
  for (const docsRoot of config.docsRoots) {
    const result = buildDocNodes({
      docsRoot,
      repoRoot: config.repoRoot,
      knownPublicPaths,
      nameIndex,
      fileIndex,
      docsLabel: rel(config.repoRoot, docsRoot),
    })
    docNodes.push(...result.nodes)
    edges.push(...result.edges)
    freshnessIgnore.push(...result.freshnessIgnore)
  }

  // Declared `@doc` anchors -> documents edges (doc-section/page -> symbol).
  const docNodeIds = new Set(docNodes.map((n) => n.id))
  for (const anchor of docAnchors) {
    const targetId = normalizeDocTarget(anchor.doc)
    const targetBase = targetId.split('#')[0]!
    const fromId = docNodeIds.has(targetId)
      ? targetId
      : docNodeIds.has(targetBase)
        ? targetBase
        : null
    if (!fromId) {
      warnings.push(`@doc on ${anchor.from} points at ${anchor.doc}, which is not a known doc node`)
      continue
    }
    edges.push({
      from: fromId,
      to: anchor.from,
      type: 'documents',
      provenance: 'declared:manual',
      confidence: 'high',
      at: { from: null, to: anchor.at },
    })
  }

  // De-duplicate doc nodes (sections can repeat a slug across pages are unique;
  // identical ids collapse) and sort everything for byte-stable output.
  const nodeById = new Map<string, GraphNode>()
  for (const n of [...codeNodes, ...docNodes]) if (!nodeById.has(n.id)) nodeById.set(n.id, n)
  const nodes = [...nodeById.values()].sort((a, b) => a.id.localeCompare(b.id))

  const edgeKey = (e: GraphEdge): string => `${e.from}|${e.to}|${e.type}|${e.provenance}`
  const edgeById = new Map<string, GraphEdge>()
  for (const e of edges) if (!edgeById.has(edgeKey(e))) edgeById.set(edgeKey(e), e)
  const sortedEdges = [...edgeById.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))

  return {
    graph: { schemaVersion: SCHEMA_VERSION, nodes, edges: sortedEdges },
    warnings,
    freshnessIgnore: [...new Set(freshnessIgnore)].sort(),
  }
}
