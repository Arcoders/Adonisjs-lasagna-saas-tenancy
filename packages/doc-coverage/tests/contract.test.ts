/**
 * Property tests for the contract hash and the tokenizer. The hash must be
 * stable under comment-only edits and change under a param-type / throws change
 * (the D3 guarantee proven in the Step-0 spike). The tokenizer must split
 * camelCase / snake_case, drop the stoplist, and honour synonyms.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { buildSymbolContract, descriptionWordCount } from '../src/contract.js'
import { tokenize, diffTokens, withSynonyms, tokenSet } from '../src/tokenize.js'

const OPTS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
}

/** Compile a source string and return the contract hash of its default export. */
function hashOf(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'doccov-'))
  const file = join(dir, 'sample.ts').replace(/\\/g, '/')
  try {
    writeFileSync(file, source)
    const program = ts.createProgram([file], OPTS)
    const checker = program.getTypeChecker()
    const sf = program.getSourceFile(file)!
    const mod = checker.getSymbolAtLocation(sf)!
    const exp = checker.getExportsOfModule(mod).find((s) => s.getName() === 'default')!
    const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp
    return buildSymbolContract(checker, sym, file).hash
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const fixture = (doc: string, amountType: string, thrown: string): string => `
export default class Sample {
${doc}
  reserve(tenantId: string, amount: ${amountType}): Promise<number> {
    if (amount as any) throw new ${thrown}('x')
    return Promise.resolve(0)
  }
  release(tenantId: string): void {}
}
`

test('contract hash ignores comment-only edits', () => {
  const a = hashOf(fixture('  /** original prose. */', 'number', 'RangeError'))
  const b = hashOf(
    fixture(
      '  /**\n   * completely rewritten description, new @example, new @remarks.\n   */',
      'number',
      'RangeError'
    )
  )
  assert.equal(a, b)
})

test('contract hash changes on a param-type change', () => {
  const a = hashOf(fixture('  /** d */', 'number', 'RangeError'))
  const b = hashOf(fixture('  /** d */', 'string', 'RangeError'))
  assert.notEqual(a, b)
})

test('contract hash changes on a throws change', () => {
  const a = hashOf(fixture('  /** d */', 'number', 'RangeError'))
  const b = hashOf(fixture('  /** d */', 'number', 'TypeError'))
  assert.notEqual(a, b)
})

test('contract hash is path-free (no absolute import paths)', () => {
  // Two temp dirs produce different absolute paths; the hash must not encode them.
  const src = fixture('  /** d */', 'number', 'RangeError')
  assert.equal(hashOf(src), hashOf(src))
})

test('descriptionWordCount counts an interface JSDoc description (not just classes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doccov-iface-'))
  const file = join(dir, 'sample.ts').replace(/\\/g, '/')
  try {
    writeFileSync(
      file,
      `/**
 * Options controlling a tenant clone: whether to copy only the schema and
 * whether to clear the destination tenant sessions after the copy completes.
 */
export interface CloneOptions {
  schemaOnly: boolean
  clearSessions: boolean
}
`
    )
    const program = ts.createProgram([file], OPTS)
    const checker = program.getTypeChecker()
    const mod = checker.getSymbolAtLocation(program.getSourceFile(file)!)!
    const exp = checker.getExportsOfModule(mod).find((s) => s.getName() === 'CloneOptions')!
    const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp
    // The leading description is ~20 words; tags would not count, but there are none.
    assert.ok(descriptionWordCount(checker, sym) >= 18, 'an interface description is counted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tokenize splits camelCase and snake_case, drops short tokens', () => {
  assert.deepEqual(tokenize('getAssignedPlan'), ['get', 'assigned', 'plan'])
  assert.deepEqual(tokenize('max_tokens'), ['max', 'tokens'])
  assert.deepEqual(tokenize('HTTPServer'), ['http', 'server'])
  assert.deepEqual(tokenize('id'), []) // below MIN_TOKEN_LENGTH
})

test('diffTokens reports the exact missing set, never a percentage', () => {
  const contract = new Set(['build', 'reset', 'size'])
  const prose = tokenSet('You call build with a size to assemble a widget.')
  const { present, missing } = diffTokens(contract, prose)
  assert.deepEqual(present, ['build', 'size'])
  assert.deepEqual(missing, ['reset'])
})

test('withSynonyms maps an alias to its canonical so it is not a false-missing', () => {
  const prose = tokenSet('the assign step writes the plan')
  const expanded = withSynonyms(prose, { assigned: ['assign'] })
  const { missing } = diffTokens(new Set(['assigned']), expanded)
  assert.deepEqual(missing, [])
})
