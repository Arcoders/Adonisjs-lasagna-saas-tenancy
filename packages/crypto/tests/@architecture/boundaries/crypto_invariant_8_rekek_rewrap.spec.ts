import { test } from '@japa/runner'
// This guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise the KEK-rotation rule: the walker re-WRAPS the DEK (calls
// KeyProvider.unwrapDek + wrapDek) and NEVER decrypts/re-encrypts a field value
// (openV2WithKey / sealV2WithKey / the core crypto import).
import { auditRekekWalker } from '../../../../../scripts/check-crypto-invariant-8.mjs'

const WALKER_PATH = 'packages/crypto/src/services/rekek_service.ts'

/** A compliant walker: re-wraps the DEK envelope, never a field value. */
const REWRAP_ONLY = [
  `import type { KeyProvider } from '../types/key_provider.js'`,
  `export default class RekekService {`,
  `  async rekekTenant(tenant, kp) {`,
  `    const dek = await kp.unwrapDek(tenant.id, { kekId: 'old', ciphertext: 'x' })`,
  `    const wrapped = await kp.wrapDek(tenant.id, dek)`,
  `    return wrapped`,
  `  }`,
  `}`,
].join('\n')

test.group('architectural: KEK rotation re-wraps DEKs', () => {
  test('a walker that only unwraps + re-wraps the DEK passes', ({ assert }) => {
    const problems = auditRekekWalker([{ path: WALKER_PATH, source: REWRAP_ONLY }])
    assert.deepEqual(problems, [])
  })

  test('a walker that names openV2WithKey is a violation (field-value decrypt)', ({ assert }) => {
    const source = [
      `import { openV2WithKey, sealV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'`,
      `export default class RekekService {`,
      `  async rekekTenant(tenant, kp, row) {`,
      `    const dek = await kp.unwrapDek(tenant.id, { kekId: row.kekId, ciphertext: row.wrappedDek })`,
      `    const plaintext = openV2WithKey(row.value, dek)`,
      `    return sealV2WithKey(plaintext, dek, row.id)`,
      `  }`,
      `}`,
    ].join('\n')
    const problems = auditRekekWalker([{ path: WALKER_PATH, source }])
    assert.isTrue(problems.some((p) => /openV2WithKey/.test(p)))
    assert.isTrue(problems.some((p) => /sealV2WithKey/.test(p)))
    // It also imports the core field-value seam, flagged on its own.
    assert.isTrue(problems.some((p) => /field-value cipher|crypto' field-value/.test(p)))
  })

  test('a walker that unwraps but never re-wraps is a violation', ({ assert }) => {
    const source = [
      `export default class RekekService {`,
      `  async rekekTenant(tenant, kp, row) {`,
      `    return kp.unwrapDek(tenant.id, { kekId: row.kekId, ciphertext: row.wrappedDek })`,
      `  }`,
      `}`,
    ].join('\n')
    const problems = auditRekekWalker([{ path: WALKER_PATH, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /wrapDek/)
  })

  test('a missing walker file is a violation (the re-wrap walker is required)', ({ assert }) => {
    const problems = auditRekekWalker([
      { path: 'packages/crypto/src/services/crypto_service.ts', source: REWRAP_ONLY },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /was not found/)
  })

  test('a doc-comment naming openV2WithKey is not a false positive', ({ assert }) => {
    const source = [
      `// This module NEVER openV2WithKey-then-sealV2WithKey on a field value (I8).`,
      `export default class RekekService {`,
      `  async rekekTenant(tenant, kp, row) {`,
      `    const dek = await kp.unwrapDek(tenant.id, { kekId: row.kekId, ciphertext: row.wrappedDek })`,
      `    return kp.wrapDek(tenant.id, dek)`,
      `  }`,
      `}`,
    ].join('\n')
    const problems = auditRekekWalker([{ path: WALKER_PATH, source }])
    assert.deepEqual(problems, [])
  })
})
