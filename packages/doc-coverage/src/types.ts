/**
 * The graph data model. See docs/dev/doc-coverage-rfc.md §3.
 *
 * A node is a code symbol or a doc fragment; an edge means "this doc explains /
 * references / exemplifies this code". The graph is bidirectional so impact
 * (code to docs) and coverage (docs to code) are the same lookup in two
 * directions. Everything here is plain JSON so `doc-graph.json` is portable and
 * cache-friendly.
 */

/** What a node represents. Code kinds drive coverage; doc kinds are the prose. */
export type NodeKind =
  | 'service'
  | 'command'
  | 'event'
  | 'exception'
  | 'middleware'
  | 'config-key'
  | 'contract-version'
  | 'public-type'
  | 'job'
  | 'function'
  | 'doc-page'
  | 'doc-section'
  | 'code-fence'
  | 'diagram'
  | 'decision'
  | 'readme-section'
  | 'changelog-entry'
  | 'example'

/**
 * The slice of a symbol that the contract hash and D2 are built from. Free text
 * (descriptions, examples) is deliberately excluded from the hash; only
 * `descriptionWordCount` survives, and only to drive the coverage quality floor.
 */
export interface JsDocContract {
  /** Public own method/signature names (the richest D2-soft token source). */
  members: string[]
  /** Every member name incl. inherited + static (D2-hard validation, avoids false dead-members). */
  allMembers: string[]
  params: { name: string; typeStr: string }[]
  throws: string[]
  returnsTypeStr: string | null
  descriptionWordCount: number
}

export interface SourceRange {
  line: number
}

export interface GraphNode {
  /** Stable identity. For public symbols this is the `publicPath`. */
  id: string
  kind: NodeKind
  /** Workspace package the node belongs to, or null for repo-level docs. */
  package: string | null
  /** Barrel identity docs cite, e.g. `@adonisjs-lasagna/saas-tenancy/services#QuotaService`. */
  publicPath: string | null
  /** Repo-relative source file (forward slashes) the freshness signal watches. */
  internalPath: string | null
  /** Path-normalized contract hash (D3). Null for nodes without a contract. */
  signatureHash: string | null
  jsdoc: JsDocContract | null
  sourceRange: SourceRange | null
  /** Build output / excluded files need no docs. */
  generated: boolean
}

export type EdgeType = 'documents' | 'references' | 'exemplifies' | 'diagrams' | 'owns' | 'links'

/** How an edge was established. The gate trusts only `declared:manual` + `derived:auto`. */
export type Provenance = 'declared:manual' | 'derived:auto' | 'inferred'

export type Confidence = 'high' | 'medium' | 'low'

export interface GraphEdge {
  from: string
  to: string
  type: EdgeType
  provenance: Provenance
  confidence: Confidence
  /** file:line for each end so the report and `--explain` can cite sources. */
  at: { from: string | null; to: string | null }
}

export interface DocGraph {
  /** Bump to invalidate the on-disk cache when the shape changes. */
  schemaVersion: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const SCHEMA_VERSION = 1

/** Code kinds that count toward the coverage metric. */
export const DOCUMENTABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'service',
  'command',
  'event',
  'exception',
  'middleware',
  'job',
  'contract-version',
])
