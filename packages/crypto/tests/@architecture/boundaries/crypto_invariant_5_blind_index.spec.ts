import { test } from '@japa/runner'
// This guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise the blind-index keyed-HMAC rule: the index is built with a
// keyed createHmac (import + call), never a bare unkeyed digest (createHash,
// including an aliased import, crypto.hash, or subtle.digest), and no salt column
// exists on the table.
import {
  auditBlindIndex,
  CREATE_HASH_ALLOWLIST,
} from '../../../../../scripts/check-crypto-invariant-5.mjs'

const BLIND_INDEX_PATH = 'packages/crypto/src/internal/blind_index.ts'
const OTHER_SRC_PATH = 'packages/crypto/src/services/crypto_service.ts'
const MIGRATION_PATH =
  'packages/crypto/tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts'

/** A keyed-HMAC blind-index module (the compliant shape). */
const KEYED_HMAC = [
  `import { createHmac } from 'node:crypto'`,
  `export function computeBlindIndex(indexKey, value) {`,
  `  return createHmac('sha256', indexKey).update(value, 'utf8').digest('hex')`,
  `}`,
].join('\n')

/** A migration body with the given `<name> text` columns, one per line. */
function migration(columns: string[]): string {
  const lines = columns.map((c) => `        ${c} text NOT NULL,`).join('\n')
  return ['this.schema.raw(`', '      CREATE TABLE ${table} (', lines, '      )`)'].join('\n')
}

test.group('architectural: blind index is a keyed HMAC', () => {
  test('a keyed-HMAC blind index + a salt-free table passes', ({ assert }) => {
    const problems = auditBlindIndex([
      { path: BLIND_INDEX_PATH, source: KEYED_HMAC },
      { path: MIGRATION_PATH, source: migration(['subject_id', 'category', 'wrapped_dek']) },
    ])
    assert.deepEqual(problems, [])
  })

  test('a bare createHash blind index is a violation (brute-forceable)', ({ assert }) => {
    const source = [
      `import { createHash } from 'node:crypto'`,
      `export function computeBlindIndex(salt, value) {`,
      `  return createHash('sha256').update(salt + value).digest('hex')`,
      `}`,
    ].join('\n')
    const problems = auditBlindIndex([{ path: BLIND_INDEX_PATH, source }])
    // Missing createHmac AND a forbidden createHash: both are flagged.
    assert.isAbove(problems.length, 0)
    assert.isTrue(problems.some((p) => /createHash/.test(p)))
    assert.isTrue(problems.some((p) => /createHmac/.test(p)))
  })

  test('a blind-index module with no createHmac is a violation', ({ assert }) => {
    const source = `export function computeBlindIndex(k, v) { return v }`
    const problems = auditBlindIndex([{ path: BLIND_INDEX_PATH, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /createHmac/)
  })

  test('a bare createHash in any other crypto src file is a violation', ({ assert }) => {
    const problems = auditBlindIndex([
      { path: BLIND_INDEX_PATH, source: KEYED_HMAC },
      {
        path: OTHER_SRC_PATH,
        source: `import { createHash } from 'node:crypto'\nconst x = createHash('sha256')`,
      },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /unkeyed digest/)
  })

  test('an aliased createHash import cannot smuggle a bare-hash index past the guard', ({
    assert,
  }) => {
    const source = [
      `import { createHash as h } from 'node:crypto'`,
      `export function computeBlindIndex(salt, value) {`,
      `  return h('sha256').update(salt + value).digest('hex')`,
      `}`,
    ].join('\n')
    const problems = auditBlindIndex([{ path: BLIND_INDEX_PATH, source }])
    assert.isTrue(
      problems.some((p) => /unkeyed digest/.test(p)),
      'the aliased createHash import is caught even though no `createHash(` call token exists'
    )
  })

  test('an aliased bare-hash index with a decoy createHmac is still flagged (no false green)', ({
    assert,
  }) => {
    const source = [
      `import { createHash as h, createHmac } from 'node:crypto'`,
      `const _decoy = () => createHmac('sha256', Buffer.alloc(1))`,
      `export function computeBlindIndex(salt, value) {`,
      `  return h('sha256').update(salt + value).digest('hex')`,
      `}`,
    ].join('\n')
    const problems = auditBlindIndex([{ path: BLIND_INDEX_PATH, source }])
    assert.isTrue(
      problems.some((p) => /unkeyed digest/.test(p)),
      'the real aliased bare-hash index is caught despite a satisfying decoy createHmac'
    )
  })

  test('a one-shot crypto.hash digest is a violation, not just createHash', ({ assert }) => {
    const source = [
      `import crypto from 'node:crypto'`,
      `export function computeBlindIndex(value) {`,
      `  return crypto.hash('sha256', value, 'hex')`,
      `}`,
    ].join('\n')
    const problems = auditBlindIndex([{ path: BLIND_INDEX_PATH, source }])
    assert.isTrue(problems.some((p) => /unkeyed digest/.test(p)))
  })

  test('a bare digest in a .mts crypto src file is scanned (extension coverage)', ({ assert }) => {
    const problems = auditBlindIndex([
      { path: BLIND_INDEX_PATH, source: KEYED_HMAC },
      {
        path: 'packages/crypto/src/services/rogue.mts',
        source: `import { createHash } from 'node:crypto'\nconst x = createHash('sha256')`,
      },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /unkeyed digest/)
  })

  test('an allowlisted file (the WORM ledger subject digest) may use createHash', ({ assert }) => {
    const wormPath = `packages/crypto/src/${CREATE_HASH_ALLOWLIST[0]}`
    const problems = auditBlindIndex([
      { path: BLIND_INDEX_PATH, source: KEYED_HMAC },
      {
        path: wormPath,
        source: `import { createHash } from 'node:crypto'\nconst d = createHash('sha256').update(id)`,
      },
    ])
    assert.deepEqual(problems, [], 'the reviewed carve-out is not flagged')
  })

  test('a plaintext salt column on the wrapped-DEK table is a violation', ({ assert }) => {
    const problems = auditBlindIndex([
      { path: BLIND_INDEX_PATH, source: KEYED_HMAC },
      { path: MIGRATION_PATH, source: migration(['subject_id', 'category', 'passport_salt']) },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /salt/)
  })

  test('a comment naming createHash is not a false positive', ({ assert }) => {
    const source = [
      `import { createHmac } from 'node:crypto'`,
      `// It is a keyed HMAC, NEVER a bare createHash(...) which is brute-forceable.`,
      `export function computeBlindIndex(indexKey, value) {`,
      `  return createHmac('sha256', indexKey).update(value).digest('hex')`,
      `}`,
    ].join('\n')
    const problems = auditBlindIndex([{ path: BLIND_INDEX_PATH, source }])
    assert.deepEqual(problems, [])
  })
})
