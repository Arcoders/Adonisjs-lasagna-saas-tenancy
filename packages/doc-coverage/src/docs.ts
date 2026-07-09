/**
 * Doc-node + edge extraction (RFC §4). Walks a docs tree and turns each page
 * into doc-page / doc-section / code-fence nodes, then resolves edges to code
 * symbols by five rules, each carrying its provenance:
 *
 *   front-matter `code:`        declared:manual  (trusted, gates)
 *   <!-- doc:ref pkg#Symbol -->  declared:manual  (trusted, gates)
 *   fence import                 derived:auto     (exemplifies; gates structurally via D1)
 *   GitHub blob URL              derived:auto     (references)
 *   backtick mention             inferred         (never gates)
 *
 * Only edges to *known* public symbols are emitted, so the gate and coverage are
 * precise. Resolution is deliberately trivial: a public path is `module#name`,
 * exactly the string a reader imports.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { GraphEdge, GraphNode } from './types.js'

export interface DocsResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Pages carrying `<!-- doc:freshness-ignore -->`, suppressed from D3. */
  freshnessIgnore: string[]
}

/** A page-level `<!-- doc:freshness-ignore reason="..." -->` directive (reason optional). */
const FRESHNESS_IGNORE_RE = /<!--\s*doc:freshness-ignore(?:\s+reason="[^"]*")?\s*-->/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '.vitepress' || entry === 'public' || entry === 'node_modules') continue
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

/** Minimal front-matter reader: the block between the first two `---` lines. */
function parseFrontMatter(content: string): { code: string[]; raw: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return { code: [], raw: '' }
  const raw = m[1]!
  const code: string[] = []
  // `code:` may be a single value or a YAML list of `- item` lines.
  const single = raw.match(/^code:\s*(.+)$/m)
  if (single && !/^\s*$/.test(single[1]!)) {
    code.push(single[1]!.trim().replace(/^['"]|['"]$/g, ''))
  }
  const listBlock = raw.match(/^code:\s*\n((?:\s*-\s*.+\n?)+)/m)
  if (listBlock) {
    for (const line of listBlock[1]!.split('\n')) {
      const item = line.match(/^\s*-\s*(.+)$/)
      if (item) code.push(item[1]!.trim().replace(/^['"]|['"]$/g, ''))
    }
  }
  return { code, raw }
}

interface FenceImport {
  module: string
  names: string[]
}

/** Extract ` ```ts ` / ` ```typescript ` fences with their start line. */
function extractFences(content: string): { startLine: number; code: string }[] {
  const lines = content.split('\n')
  const blocks: { startLine: number; code: string }[] = []
  let i = 0
  while (i < lines.length) {
    if (/^```(ts|typescript)\b/.test(lines[i]!)) {
      const startLine = i + 1
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      blocks.push({ startLine, code: body.join('\n') })
    }
    i++
  }
  return blocks
}

/**
 * Pull named + default imports out of a fence body. The package scope is not
 * filtered here; an edge only forms when `module#name` resolves to a KNOWN
 * public path (see `buildDocNodes`), so any vendor import is harmlessly ignored
 * and the tool stays package-agnostic.
 */
function fenceImports(code: string): FenceImport[] {
  const out: FenceImport[] = []
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const names = m[1]!
      .split(',')
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim()
      )
      .filter(Boolean)
    if (names.length) out.push({ module: m[2]!, names })
  }
  // default import: `import Foo from '<module>'`
  const reDefault = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g
  while ((m = reDefault.exec(code)) !== null) out.push({ module: m[2]!, names: [m[1]!] })
  return out
}

export interface DocsOptions {
  docsRoot: string
  repoRoot: string
  /** All known public paths, to validate edges against. */
  knownPublicPaths: Set<string>
  /** name -> publicPaths, for disambiguating backtick mentions. */
  nameIndex: Map<string, string[]>
  /** repo-relative internalPath -> publicPaths declared in that file (GitHub URL resolution). */
  fileIndex: Map<string, string[]>
  /** Doc label for the docs tree, e.g. `docs`. */
  docsLabel: string
}

export function buildDocNodes(opts: DocsOptions): DocsResult {
  const { docsRoot, repoRoot, knownPublicPaths, nameIndex, fileIndex } = opts
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const freshnessIgnore: string[] = []
  const seenEdge = new Set<string>()

  const addEdge = (e: GraphEdge): void => {
    const key = `${e.from}|${e.to}|${e.type}|${e.provenance}`
    if (seenEdge.has(key)) return
    seenEdge.add(key)
    edges.push(e)
  }

  const docNode = (
    id: string,
    kind: GraphNode['kind'],
    internalPath: string,
    line: number
  ): GraphNode => ({
    id,
    kind,
    package: null,
    publicPath: null,
    internalPath,
    signatureHash: null,
    jsdoc: null,
    sourceRange: { line },
    generated: false,
  })

  for (const file of walk(docsRoot)) {
    // Normalize CRLF -> LF on read: this repo has CRLF working copies, and the
    // front-matter / heading / fence parsing below all assume LF line endings.
    // Without this, a CRLF-committed doc silently loses its `code:` anchors.
    const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const rel = relative(repoRoot, file).replace(/\\/g, '/')
    const pageId = rel
    nodes.push(docNode(pageId, 'doc-page', rel, 1))

    // A page-level opt-out: silence D3 freshness for this whole page (the unit a
    // maintainer reviews). This is the escape valve the report advertises.
    if (FRESHNESS_IGNORE_RE.test(content)) freshnessIgnore.push(rel)

    const { code: fmCode } = parseFrontMatter(content)
    const lines = content.split('\n')

    // doc-section nodes from headings.
    lines.forEach((ln, idx) => {
      const h = ln.match(/^(#{2,4})\s+(.+?)\s*$/)
      if (h) {
        const slug = slugify(h[2]!)
        const sectionId = `${rel}#${slug}`
        nodes.push(docNode(sectionId, 'doc-section', rel, idx + 1))
        addEdge({
          from: pageId,
          to: sectionId,
          type: 'owns',
          provenance: 'derived:auto',
          confidence: 'high',
          at: { from: `${rel}:1`, to: `${rel}:${idx + 1}` },
        })
      }
    })

    // 1. front-matter `code:` -> declared:manual documents edge from the page.
    for (const target of fmCode) {
      if (knownPublicPaths.has(target)) {
        addEdge({
          from: pageId,
          to: target,
          type: 'documents',
          provenance: 'declared:manual',
          confidence: 'high',
          at: { from: `${rel}:1`, to: null },
        })
      }
    }

    // 2. <!-- doc:ref pkg#Symbol --> anywhere -> declared:manual.
    const refRe = /<!--\s*doc:ref\s+([^\s]+)\s*-->/g
    let rm: RegExpExecArray | null
    while ((rm = refRe.exec(content)) !== null) {
      const target = rm[1]!
      if (knownPublicPaths.has(target)) {
        const line = content.slice(0, rm.index).split('\n').length
        addEdge({
          from: pageId,
          to: target,
          type: 'documents',
          provenance: 'declared:manual',
          confidence: 'high',
          at: { from: `${rel}:${line}`, to: null },
        })
      }
    }

    // 3. fence imports -> derived:auto exemplifies (the D1 edges).
    for (const fence of extractFences(content)) {
      const fenceId = `${rel}:fence:${fence.startLine}`
      let fenceHasEdge = false
      for (const imp of fenceImports(fence.code)) {
        for (const name of imp.names) {
          const publicPath = `${imp.module}#${name}`
          if (!knownPublicPaths.has(publicPath)) continue
          if (!fenceHasEdge) {
            nodes.push(docNode(fenceId, 'code-fence', rel, fence.startLine))
            fenceHasEdge = true
          }
          addEdge({
            from: fenceId,
            to: publicPath,
            type: 'exemplifies',
            provenance: 'derived:auto',
            confidence: 'high',
            at: { from: `${rel}:${fence.startLine}`, to: null },
          })
        }
      }
    }

    // 4. GitHub blob URLs -> derived:auto references (file-level): attach to every
    // known symbol declared in that exact source file.
    const urlRe = /github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(packages\/[^\s#)"']+)/g
    let um: RegExpExecArray | null
    const urlPaths = new Set<string>()
    while ((um = urlRe.exec(content)) !== null) urlPaths.add(um[1]!.replace(/#.*$/, ''))
    for (const path of urlPaths) {
      for (const target of fileIndex.get(path) ?? []) {
        addEdge({
          from: pageId,
          to: target,
          type: 'references',
          provenance: 'derived:auto',
          confidence: 'medium',
          at: { from: `${rel}:1`, to: null },
        })
      }
    }

    // 5. backtick mentions -> inferred (never gates), unique names only.
    const mentionRe = /`([A-Z][A-Za-z0-9_]{3,})`/g
    let mm: RegExpExecArray | null
    const mentioned = new Set<string>()
    while ((mm = mentionRe.exec(content)) !== null) mentioned.add(mm[1]!)
    for (const name of mentioned) {
      const targets = nameIndex.get(name)
      if (!targets || targets.length !== 1) continue
      addEdge({
        from: pageId,
        to: targets[0]!,
        type: 'references',
        provenance: 'inferred',
        confidence: 'low',
        at: { from: `${rel}:1`, to: null },
      })
    }
  }

  return { nodes, edges, freshnessIgnore }
}
