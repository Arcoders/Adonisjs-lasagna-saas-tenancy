/**
 * The contract hash (RFC §8, D3) and the JSDoc contract (D2). Proven in the
 * Step-0 spike on the real `QuotaService`.
 *
 * The hash input is the symbol's *contract*: signature param names + types +
 * return type + the set of exception classes it throws. It deliberately excludes
 * every word of free text (descriptions, `@example`, `@remarks`), so a
 * comment-only edit does not move the hash, while a param rename / type change /
 * new throw does. Two durability rules learned from the spike:
 *
 *   1. Never use `UseFullyQualifiedType`, which embeds absolute `import("C:/…")`
 *      paths and breaks cross-OS reproducibility. Residual `import("…")`
 *      qualifiers are stripped to a repo-relative `<pkg>/<path>:Name` form.
 *   2. Throws are read from `throw new X(…)` in the body, because real Lasagna
 *      JSDoc is prose-style and almost never uses `@throws` tags.
 */
import ts from 'typescript'
import { createHash } from 'node:crypto'
import type { JsDocContract } from './types.js'

const TYPE_FMT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrayAsGenericType

/** Strip absolute compiler paths from a printed type so the hash is OS-stable. */
export function normalizeType(s: string): string {
  return s
    .replace(/import\("[^"]*?\/packages\/([^/"]+)\/src\/([^"]*?)"\)\./g, '$1/$2:')
    .replace(/import\("[^"]*?"\)\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Collect the exception classes a declaration throws, via `throw new X(…)`. */
export function throwsOf(decl: ts.FunctionLikeDeclarationBase): string[] {
  const set = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isThrowStatement(n) && n.expression && ts.isNewExpression(n.expression)) {
      set.add(n.expression.expression.getText())
    }
    ts.forEachChild(n, visit)
  }
  if (decl.body) visit(decl.body)
  return [...set].sort()
}

export interface MethodContract {
  name: string
  params: { name: string; type: string }[]
  ret: string
  throws: string[]
}

function signatureContract(
  checker: ts.TypeChecker,
  name: string,
  decl: ts.SignatureDeclaration
): MethodContract | null {
  const sig = checker.getSignatureFromDeclaration(decl)
  if (!sig) return null
  const params = sig.getParameters().map((p) => ({
    name: p.getName(),
    type: normalizeType(
      checker.typeToString(checker.getTypeOfSymbolAtLocation(p, decl), decl, TYPE_FMT)
    ),
  }))
  const throws = ts.isFunctionLike(decl) ? throwsOf(decl as ts.FunctionLikeDeclarationBase) : []
  return {
    name,
    params,
    ret: normalizeType(checker.typeToString(sig.getReturnType(), decl, TYPE_FMT)),
    throws,
  }
}

export interface SymbolContract {
  /** Sorted public method/signature contracts. */
  members: MethodContract[]
  /** The exact string the hash is taken over (useful for `--explain`). */
  contractString: string
  /** sha256 of the normalized contract string. */
  hash: string
  jsdoc: JsDocContract
}

/**
 * Word count of a symbol's leading JSDoc description (excluding `@param`/`@returns`
 * tags). Reads from the aliased original declaration, so it works for a class, a
 * function, OR an interface/type re-exported through a barrel. The coverage metric
 * treats a description of >= 20 words as "explained".
 */
export function descriptionWordCount(checker: ts.TypeChecker, symbol: ts.Symbol): number {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
  return text ? text.split(/\s+/).length : 0
}

/**
 * Build the contract for an exported symbol. Classes contribute their public
 * (non-private/protected) methods declared in `internalFile`; callable symbols
 * contribute their call signature; anything else contributes its type string.
 */
export function buildSymbolContract(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  internalFile: string
): SymbolContract {
  const members: MethodContract[] = []
  const allMemberNames = new Set<string>()

  const isClass = (symbol.flags & ts.SymbolFlags.Class) !== 0
  if (isClass) {
    const instanceType = checker.getDeclaredTypeOfSymbol(symbol)
    // Full member set (incl. inherited instance + static) so D2-hard never flags
    // a real inherited/static method (e.g. a Job's static `dispatch`).
    for (const p of instanceType.getProperties()) allMemberNames.add(p.getName())
    if (symbol.valueDeclaration) {
      const staticType = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration)
      for (const p of staticType.getProperties()) allMemberNames.add(p.getName())
    }
    for (const prop of instanceType.getProperties()) {
      const decl = prop.valueDeclaration
      if (!decl || !ts.isMethodDeclaration(decl)) continue
      if (decl.getSourceFile().fileName.replace(/\\/g, '/') !== internalFile) continue
      const mods = ts.getCombinedModifierFlags(decl)
      if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue
      const mc = signatureContract(checker, prop.getName(), decl)
      if (mc) members.push(mc)
    }
  } else {
    const decl = symbol.valueDeclaration ?? symbol.declarations?.[0]
    if (decl && (ts.isFunctionDeclaration(decl) || ts.isMethodSignature(decl))) {
      const mc = signatureContract(checker, symbol.getName(), decl as ts.SignatureDeclaration)
      if (mc) members.push(mc)
    } else if (decl) {
      const type = checker.getTypeOfSymbolAtLocation(symbol, decl)
      const callSigs = type.getCallSignatures()
      if (callSigs.length > 0) {
        const sigDecl = callSigs[0]!.getDeclaration()
        if (sigDecl) {
          const mc = signatureContract(checker, symbol.getName(), sigDecl)
          if (mc) members.push(mc)
        }
      }
    }
  }

  members.sort((a, b) => a.name.localeCompare(b.name))

  const contractString = members
    .map(
      (m) =>
        `${m.name}(${m.params.map((p) => `${p.name}:${p.type}`).join(',')}):${m.ret}` +
        (m.throws.length ? ` throws[${m.throws.join(',')}]` : '')
    )
    .join('\n')

  const hash = createHash('sha256').update(contractString.replace(/\r\n/g, '\n')).digest('hex')

  const allParams = members.flatMap((m) => m.params.map((p) => ({ name: p.name, typeStr: p.type })))
  const allThrows = [...new Set(members.flatMap((m) => m.throws))].sort()
  const returnsTypeStr = members.length === 1 ? members[0]!.ret : null

  return {
    members,
    contractString,
    hash,
    jsdoc: {
      members: members.map((m) => m.name),
      allMembers: [...new Set([...allMemberNames, ...members.map((m) => m.name)])].sort(),
      params: allParams,
      throws: allThrows,
      returnsTypeStr,
      descriptionWordCount: descriptionWordCount(checker, symbol),
    },
  }
}
