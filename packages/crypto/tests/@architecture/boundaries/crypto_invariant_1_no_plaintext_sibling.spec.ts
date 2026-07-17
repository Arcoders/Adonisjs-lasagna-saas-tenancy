import { test } from '@japa/runner'
// This guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise the encrypted-model surface rule: the decorators own the column
// and every @encrypted/@searchable property is a ciphertext string (no plaintext type).
import { auditEncryptedModelSurface } from '../../../../../scripts/check-crypto-invariant-1.mjs'

const DEF_PATH = 'packages/crypto/src/models/encrypted_columns.ts'
const MODEL_PATH = 'packages/crypto/tests/fixtures/encrypted_model.ts'

/** A compliant decorator-definition file: both decorators apply lucidColumn. */
const GOOD_DEF = [
  `export function encrypted(options) {`,
  `  return (target, key) => {`,
  `    lucidColumn()(target, key)`,
  `  }`,
  `}`,
  `export function searchable(options) {`,
  `  return (target, key) => {`,
  `    lucidColumn({ serializeAs: null })(target, key)`,
  `  }`,
  `}`,
].join('\n')

/** A compliant model: ciphertext string columns, multi-line arrow resolvers. */
const GOOD_MODEL = [
  `export default class Renter extends compose(TenantBaseModel, withEncryptedFields) {`,
  `  @column({ isPrimary: true }) declare id: string`,
  `  @encrypted({ category: 'identity-docs', subject: (row) => row.id })`,
  `  declare passportNumber: string | null`,
  `  @searchable({ category: 'identity-docs', from: (row) => row.passportNumber })`,
  `  declare passportNumberIndex: string | null`,
  `}`,
].join('\n')

test.group('architectural: encrypted-model surface', () => {
  test('a ciphertext-string model + column-owning decorators pass', ({ assert }) => {
    const problems = auditEncryptedModelSurface([
      { path: DEF_PATH, source: GOOD_DEF },
      { path: MODEL_PATH, source: GOOD_MODEL },
    ])
    assert.deepEqual(problems, [])
  })

  test('a non-string @encrypted type is a plaintext-typed column violation', ({ assert }) => {
    const source = [
      `export default class Renter {`,
      `  @encrypted({ category: 'c', subject: (row) => row.id })`,
      `  declare age: number`,
      `}`,
    ].join('\n')
    const problems = auditEncryptedModelSurface([{ path: MODEL_PATH, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /age.*number.*ciphertext string/)
  })

  test('a Buffer / array / Date typed encrypted column is refused', ({ assert }) => {
    const source = [
      `class M {`,
      `  @encrypted({ category: 'c', subject: (r) => r.id }) declare blob: Buffer`,
      `  @encrypted({ category: 'c', subject: (r) => r.id }) declare tags: string[]`,
      `  @searchable({ category: 'c', from: (r) => r.x }) declare when: Date | null`,
      `}`,
    ].join('\n')
    const problems = auditEncryptedModelSurface([{ path: MODEL_PATH, source }])
    assert.lengthOf(problems, 3)
    assert.isTrue(problems.every((p) => /ciphertext string/.test(p)))
  })

  test('string | null | undefined unions are accepted', ({ assert }) => {
    const source = [
      `class M {`,
      `  @encrypted({ category: 'c', subject: (r) => r.id }) declare a: string`,
      `  @encrypted({ category: 'c', subject: (r) => r.id }) declare b: string | null`,
      `  @encrypted({ category: 'c', subject: (r) => r.id }) declare c: string | undefined`,
      `  @encrypted({ category: 'c', subject: (r) => r.id }) declare d: null | string`,
      `}`,
    ].join('\n')
    assert.deepEqual(auditEncryptedModelSurface([{ path: MODEL_PATH, source }]), [])
  })

  test('a decorator whose function drops lucidColumn is a violation', ({ assert }) => {
    const def = [
      `export function encrypted(options) {`,
      `  return (target, key) => { slot(target.constructor).encrypted.push({}) }`,
      `}`,
      `export function searchable(options) {`,
      `  return (target, key) => { lucidColumn({ serializeAs: null })(target, key) }`,
      `}`,
    ].join('\n')
    const problems = auditEncryptedModelSurface([{ path: DEF_PATH, source: def }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /encrypted\(\) must apply lucidColumn/)
  })

  test('a searchable() without serializeAs: null is a leak violation', ({ assert }) => {
    const def = [
      `export function encrypted(options) {`,
      `  return (target, key) => { lucidColumn()(target, key) }`,
      `}`,
      `export function searchable(options) {`,
      `  return (target, key) => { lucidColumn()(target, key) }`,
      `}`,
    ].join('\n')
    const problems = auditEncryptedModelSurface([{ path: DEF_PATH, source: def }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /serializeAs: null/)
  })

  test('a token in a comment / JSDoc is not a false positive', ({ assert }) => {
    const source = [
      `// @encrypted foo: number  <- this is prose, not a real decorator`,
      `/** Marks a column @searchable with a bare hash. */`,
      `class M {`,
      `  @encrypted({ category: 'c', subject: (r) => r.id }) declare a: string`,
      `}`,
    ].join('\n')
    assert.deepEqual(auditEncryptedModelSurface([{ path: MODEL_PATH, source }]), [])
  })

  test('a token inside a string / template literal is not a false positive', ({ assert }) => {
    const source = [
      `export const HELP = 'Decorate a field with @encrypted({ category }) to seal it'`,
      'const usage = `Add @searchable({ from: (r) => r.x }) for equality search`',
      `class M {`,
      `  @encrypted({ category: 'c', subject: (r) => r.id }) declare a: string`,
      `}`,
    ].join('\n')
    assert.deepEqual(auditEncryptedModelSurface([{ path: MODEL_PATH, source }]), [])
  })

  test('an unbalanced paren inside a category string does not desync the matcher', ({ assert }) => {
    // The stray '(' lives in a string literal; stripNonCode blanks it, so matchParen
    // still finds the decorator's true close and the non-string type is still caught.
    const source = [
      `class M {`,
      `  @encrypted({ category: 'billing (legacy', subject: (r) => r.id }) declare amount: number`,
      `}`,
    ].join('\n')
    const problems = auditEncryptedModelSurface([{ path: MODEL_PATH, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /amount.*number.*ciphertext string/)
  })

  test('empty file set is vacuously ok', ({ assert }) => {
    assert.deepEqual(auditEncryptedModelSurface([]), [])
  })
})
