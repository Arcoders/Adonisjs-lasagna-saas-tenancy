/**
 * Code-node extraction. Walks each public barrel (an `exports`-map subpath's
 * `index.ts`), resolves every re-export to its declaring symbol via the TS
 * checker (`getAliasedSymbol`, the barrel resolution proven in the spike), and
 * emits one graph node per public symbol tagged with its kind and contract hash.
 *
 * A symbol re-exported from several barrels is de-duplicated by its declaration
 * identity; the first (most specific) public path wins.
 */
import ts from 'typescript'
import { relative } from 'node:path'
import type { GraphNode } from './types.js'
import { buildSymbolContract, descriptionWordCount } from './contract.js'
import { conventionKind, readKindDoc, resolveKind } from './kinds.js'

export interface BarrelSpec {
  /** `exports`-map subpath, e.g. `services` (`.` for the root barrel). */
  subpath: string
  packageName: string
  /** Public scope docs cite, e.g. `@adonisjs-lasagna/saas-tenancy/services`. */
  publicScope: string
  /** Absolute path to the barrel's source `index.ts`. */
  indexFile: string
}

const repoRel = (abs: string, repoRoot: string): string =>
  relative(repoRoot, abs).replace(/\\/g, '/')

function resolveAlias(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol {
  return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
}

/** A declared `@doc docs/…#section` anchor on a symbol (becomes a declared edge). */
export interface DocAnchor {
  from: string
  doc: string
  at: string
}

export interface CodeNodeResult {
  nodes: GraphNode[]
  docAnchors: DocAnchor[]
}

export function buildCodeNodes(
  program: ts.Program,
  checker: ts.TypeChecker,
  barrels: BarrelSpec[],
  repoRoot: string
): CodeNodeResult {
  // Keyed by declaration identity (internalFile#name) so a symbol re-exported
  // from multiple barrels collapses to one node. The first barrel to claim a
  // symbol wins its public path, so process specific subpaths before the root
  // `.` barrel: docs cite `/services#QuotaService`, not the root re-export.
  const byDecl = new Map<string, GraphNode>()
  const docAnchors: DocAnchor[] = []

  const ordered = [...barrels].sort((a, b) => {
    const ar = a.subpath === '.' ? 1 : 0
    const br = b.subpath === '.' ? 1 : 0
    if (ar !== br) return ar - br
    return b.subpath.length - a.subpath.length
  })
  for (const barrel of ordered) {
    const sf = program.getSourceFile(barrel.indexFile)
    if (!sf) continue
    const moduleSymbol = checker.getSymbolAtLocation(sf)
    if (!moduleSymbol) continue

    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const exportName = exp.getName()
      if (exportName === 'default') continue
      const aliased = resolveAlias(checker, exp)
      const decl = aliased.declarations?.[0]
      if (!decl) continue

      const file = decl.getSourceFile().fileName.replace(/\\/g, '/')
      // Only repo source, never node_modules or generated build output.
      if (file.includes('/node_modules/') || file.includes('/build/')) continue
      const internalPath = repoRel(file, repoRoot)
      if (!internalPath.startsWith('packages/')) continue

      const declKey = `${internalPath}#${aliased.getName()}`
      if (byDecl.has(declKey)) continue

      const isClass = (aliased.flags & ts.SymbolFlags.Class) !== 0
      const isConst =
        !!aliased.valueDeclaration && ts.isVariableDeclaration(aliased.valueDeclaration) && !isClass
      let isCallable = false
      try {
        const dnode = aliased.valueDeclaration ?? decl
        const t = checker.getTypeOfSymbolAtLocation(aliased, dnode)
        isCallable = t.getCallSignatures().length > 0
      } catch {
        isCallable = false
      }

      const { kind: declaredKind, doc: declaredDoc } = readKindDoc(decl)
      const convention = conventionKind({
        subpath: barrel.subpath,
        fileName: file,
        symbolName: exportName,
        isClass,
        isConst,
        isCallable,
      })
      const kind = resolveKind(declaredKind, convention)

      let signatureHash: string | null = null
      let jsdoc: GraphNode['jsdoc'] = null
      if (isClass || isCallable || ts.isFunctionDeclaration(decl)) {
        // buildSymbolContract filters methods by their declaring file, which is
        // the ABSOLUTE forward-slash path, not the repo-relative one.
        const contract = buildSymbolContract(checker, aliased, file)
        jsdoc = contract.jsdoc
        signatureHash = contract.contractString ? contract.hash : null
      } else {
        // Interfaces / type aliases / enums have no method contract to hash, but a
        // substantial JSDoc description still documents them. Capture just the
        // description word count so the coverage metric can credit it.
        jsdoc = {
          members: [],
          allMembers: [],
          params: [],
          throws: [],
          returnsTypeStr: null,
          descriptionWordCount: descriptionWordCount(checker, aliased),
        }
      }

      const publicPath = `${barrel.publicScope}#${exportName}`
      const line = decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart()).line + 1

      byDecl.set(declKey, {
        id: publicPath,
        kind,
        package: barrel.packageName,
        publicPath,
        internalPath,
        signatureHash,
        jsdoc,
        sourceRange: { line },
        generated: false,
      })

      if (declaredDoc) {
        docAnchors.push({ from: publicPath, doc: declaredDoc, at: `${internalPath}:${line}` })
      }
    }
  }

  return {
    nodes: [...byDecl.values()].sort((a, b) => a.id.localeCompare(b.id)),
    docAnchors,
  }
}
