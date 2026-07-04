import { test } from '@japa/runner'
// The I4 guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise domain separation (T7 confused-deputy resistance): the field seal
// is keyed by the per-row DEK, and the derived keys use distinct salts + a category-bound
// blind-index key.
import { auditDomainSeparation } from '../../../../../scripts/check-crypto-invariant-4.mjs'

const SERVICE = 'packages/crypto/src/services/crypto_service.ts'
const PROVIDER = 'packages/crypto/src/services/env_key_provider.ts'

const GOOD_SERVICE = [
  `import { sealV2WithKey, openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'`,
  `export default class CryptoService {`,
  `  async encryptField(t, s, c, plaintext) {`,
  `    const { dek, keyId } = await this.#liveDek(t, s, c)`,
  `    return sealV2WithKey(plaintext, dek, keyId)`,
  `  }`,
  `  async decryptField(t, s, c, ciphertext) {`,
  `    const live = await this.#liveDek(t, s, c)`,
  `    return openV2WithKey(ciphertext, live.dek)`,
  `  }`,
  `}`,
].join('\n')

const GOOD_PROVIDER = [
  `const KEK_SALT = Buffer.from('lasagna:crypto:kek:v1')`,
  `const KEK_ID_SALT = Buffer.from('lasagna:crypto:kek-id:v1')`,
  `const INDEX_KEY_SALT = Buffer.from('lasagna:crypto:blind-index:v1')`,
  `export default class EnvKeyProvider {`,
  `  async deriveIndexKey(tenantId, category) {`,
  `    return Buffer.from(hkdfSync('sha256', k, INDEX_KEY_SALT, indexKeyInfo(tenantId, category), 32))`,
  `  }`,
  `}`,
].join('\n')

function goodFiles() {
  return [
    { path: SERVICE, source: GOOD_SERVICE },
    { path: PROVIDER, source: GOOD_PROVIDER },
  ]
}

test.group('architectural — I4 domain separation', () => {
  test('per-row-DEK seal + distinct salts + category-bound index passes', ({ assert }) => {
    assert.deepEqual(auditDomainSeparation(goodFiles()), [])
  })

  test('a field key derived via hkdfSync in the service is a violation (shared key, T7)', ({
    assert,
  }) => {
    const service = [
      `import { sealV2WithKey, openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'`,
      `export default class CryptoService {`,
      `  async encryptField(t, s, c, plaintext) {`,
      `    const dek = hkdfSync('sha256', appKey, salt, c, 32)`,
      `    return sealV2WithKey(plaintext, dek, 'k')`,
      `  }`,
      `  async decryptField(t, s, c, ciphertext) { return openV2WithKey(ciphertext, live.dek) }`,
      `}`,
    ].join('\n')
    const problems = auditDomainSeparation([
      { path: SERVICE, source: service },
      { path: PROVIDER, source: GOOD_PROVIDER },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /must NOT derive a field key via hkdfSync/)
  })

  test('a field seal keyed by a shared (non-DEK) key is a violation', ({ assert }) => {
    const service = [
      `import { sealV2WithKey, openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'`,
      `export default class CryptoService {`,
      `  async encryptField(t, s, c, plaintext) { return sealV2WithKey(plaintext, sharedKey, 'k') }`,
      `  async decryptField(t, s, c, ct) { return openV2WithKey(ct, sharedKey) }`,
      `}`,
    ].join('\n')
    const problems = auditDomainSeparation([
      { path: SERVICE, source: service },
      { path: PROVIDER, source: GOOD_PROVIDER },
    ])
    assert.lengthOf(problems, 2)
    assert.isTrue(problems.every((p) => /keyed by the per-row DEK/.test(p)))
  })

  test('two identical HKDF salts are a violation', ({ assert }) => {
    const provider = [
      `const KEK_SALT = Buffer.from('lasagna:crypto:shared')`,
      `const INDEX_KEY_SALT = Buffer.from('lasagna:crypto:shared')`,
      `async deriveIndexKey(tenantId, category) { return hkdfSync('sha256', k, INDEX_KEY_SALT, category, 32) }`,
    ].join('\n')
    const problems = auditDomainSeparation([
      { path: SERVICE, source: GOOD_SERVICE },
      { path: PROVIDER, source: provider },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /pairwise DISTINCT/)
  })

  test('a blind-index key that ignores category is a violation (not injective)', ({ assert }) => {
    const provider = [
      `const KEK_SALT = Buffer.from('a')`,
      `const INDEX_KEY_SALT = Buffer.from('b')`,
      `async deriveIndexKey(tenantId, category) { return hkdfSync('sha256', k, INDEX_KEY_SALT, tenantId, 32) }`,
    ].join('\n')
    const problems = auditDomainSeparation([
      { path: SERVICE, source: GOOD_SERVICE },
      { path: PROVIDER, source: provider },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /bind 'category'/)
  })
})
