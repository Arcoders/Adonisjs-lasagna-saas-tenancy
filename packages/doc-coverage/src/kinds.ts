/**
 * Kind inference: convention default + `@kind`/`@doc` override (RFC §8.4). Proven
 * in the Step-0 spike: a class in `*_service.ts` exported from `/services` is a
 * `service` with zero annotations, and an explicit `@kind ai-provider-contract`
 * overrides the convention. A new kind is a new tag, never a tool change.
 */
import ts from 'typescript'
import type { NodeKind } from './types.js'

export interface KindDoc {
  kind: string | null
  doc: string | null
}

/** Read `@kind` / `@doc` JSDoc tags off a declaration. */
export function readKindDoc(decl: ts.Node): KindDoc {
  const tags = ts.getJSDocTags(decl)
  const get = (name: string): string | null => {
    const tag = tags.find((t) => t.tagName.getText() === name)
    if (!tag) return null
    if (typeof tag.comment === 'string') return tag.comment.trim()
    const text = ts.getTextOfJSDocComment(tag.comment)
    return text ? text.trim() : null
  }
  return { kind: get('kind'), doc: get('doc') }
}

export interface ConventionInput {
  /** The `exports`-map subpath the symbol is reachable from, e.g. `services`. */
  subpath: string
  /** Internal source file (forward slashes). */
  fileName: string
  symbolName: string
  isClass: boolean
  isConst: boolean
  isCallable: boolean
}

/** The zero-annotation default kind, by subpath + filename + name convention. */
export function conventionKind(input: ConventionInput): NodeKind {
  const { subpath, fileName, symbolName, isClass, isConst, isCallable } = input

  if (/_CONTRACT_VERSION$/.test(symbolName) || /^[A-Z_]+_CONTRACT_VERSION$/.test(symbolName)) {
    return 'contract-version'
  }
  if (subpath === 'events' || /\/events\//.test(fileName)) return 'event'
  if (subpath === 'exceptions' || /Exception$/.test(symbolName)) return 'exception'
  if (subpath === 'jobs' || /\/jobs\//.test(fileName) || /Job$/.test(symbolName)) return 'job'
  if (subpath === 'middleware' || /Middleware$/.test(symbolName)) return 'middleware'
  if (
    subpath === 'services' ||
    /_service\.ts$/.test(fileName) ||
    (isClass && /Service$/.test(symbolName))
  ) {
    return 'service'
  }
  if (isConst && !isCallable) return 'config-key'
  if (isClass) return 'public-type'
  if (isCallable) return 'function'
  return 'public-type'
}

/** Coerce a declared `@kind` string to a known NodeKind, or fall back. */
const KNOWN_KINDS: ReadonlySet<string> = new Set<NodeKind>([
  'service',
  'command',
  'event',
  'exception',
  'middleware',
  'config-key',
  'contract-version',
  'public-type',
  'job',
  'function',
])

export function resolveKind(declared: string | null, convention: NodeKind): NodeKind {
  if (declared && KNOWN_KINDS.has(declared)) return declared as NodeKind
  // An unknown declared kind (e.g. `ai-provider-contract`) is recorded as a
  // public-type so the symbol still counts; the raw tag is kept on the edge side.
  if (declared) return 'public-type'
  return convention
}
