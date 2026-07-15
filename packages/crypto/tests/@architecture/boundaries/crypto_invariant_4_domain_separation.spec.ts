import { test } from '@japa/runner'
// This guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise domain separation (confused-deputy resistance): the field seal
// is keyed by the per-row DEK, HKDF lives ONLY in the KeyProvider, the frozen byte
// constants are distinct, and the blind-index key is category-bound.
import { auditDomainSeparation } from '../../../../../scripts/check-crypto-invariant-4.mjs'

const SERVICE = 'packages/crypto/src/services/crypto_service.ts'
const PROVIDER = 'packages/crypto/src/services/env_key_provider.ts'
const INTERNAL = 'packages/crypto/src/internal/derive.ts'

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
  `function indexKeyInfo(tenantId, category) {`,
  `  return Buffer.from(JSON.stringify([tenantId, category]), 'utf8')`,
  `}`,
].join('\n')

function goodFiles() {
  return [
    { path: SERVICE, source: GOOD_SERVICE },
    { path: PROVIDER, source: GOOD_PROVIDER },
  ]
}

test.group('architectural: domain separation', () => {
  test('per-row-DEK seal + distinct salts + category-bound index passes', ({ assert }) => {
    assert.deepEqual(auditDomainSeparation(goodFiles()), [])
  })

  test('hkdfSync in the service (a context-derived field key) is a violation', ({ assert }) => {
    const service = GOOD_SERVICE.replace(
      `const { dek, keyId } = await this.#liveDek(t, s, c)`,
      `const dek = hkdfSync('sha256', appKey, salt, c, 32); const keyId = 'k'`
    )
    const problems = auditDomainSeparation([
      { path: SERVICE, source: service },
      { path: PROVIDER, source: GOOD_PROVIDER },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /hkdfSync appears outside the KeyProvider/)
  })

  test('a shared field key derived in an internal helper (imported as `dek`) is a violation', ({
    assert,
  }) => {
    // The bypass: move the derivation OUT of crypto_service into a helper the guard used
    // to never scan, then name the result `dek`. The whole-src hkdfSync scan catches it.
    const internal = [
      `import { hkdfSync } from 'node:crypto'`,
      `export function deriveSharedFieldKey(category) {`,
      `  return hkdfSync('sha256', appKey, salt, category, 32)`,
      `}`,
    ].join('\n')
    const problems = auditDomainSeparation([
      { path: SERVICE, source: GOOD_SERVICE },
      { path: PROVIDER, source: GOOD_PROVIDER },
      { path: INTERNAL, source: internal },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /derive\.ts: hkdfSync appears outside the KeyProvider/)
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

  test('two identical byte constants are a violation, whatever the quote style', ({ assert }) => {
    for (const collision of [
      `const KEK_SALT = Buffer.from('lasagna:crypto:shared')\nconst INDEX_KEY_SALT = Buffer.from("lasagna:crypto:shared")`,
      "const KEK_SALT = Buffer.from('lasagna:crypto:shared')\nlet INDEX_KEY_SALT = Buffer.from(`lasagna:crypto:shared`)",
      // Non-`_SALT` name still collected.
      `const KEK_SALT = Buffer.from('lasagna:crypto:shared')\nconst INDEX_KDF = Buffer.from('lasagna:crypto:shared')`,
    ]) {
      const provider = [
        collision,
        `async deriveIndexKey(tenantId, category) { return hkdfSync('sha256', k, INDEX_KEY_SALT, indexKeyInfo(tenantId, category), 32) }`,
        `function indexKeyInfo(t, category) { return Buffer.from(JSON.stringify([t, category])) }`,
      ].join('\n')
      const problems = auditDomainSeparation([
        { path: SERVICE, source: GOOD_SERVICE },
        { path: PROVIDER, source: provider },
      ])
      assert.isTrue(
        problems.some((p) => /identical/.test(p)),
        `should flag collision:\n${collision}`
      )
    }
  })

  test('a blind-index derivation that drops category from the hkdfSync info is a violation', ({
    assert,
  }) => {
    const provider = [
      `const KEK_SALT = Buffer.from('a')`,
      `const INDEX_KEY_SALT = Buffer.from('b')`,
      // category is still referenced (dead) but the info arg omits it.
      `async deriveIndexKey(tenantId, category) {`,
      `  const _unused = category`,
      `  return hkdfSync('sha256', k, INDEX_KEY_SALT, Buffer.from(tenantId), 32)`,
      `}`,
    ].join('\n')
    const problems = auditDomainSeparation([
      { path: SERVICE, source: GOOD_SERVICE },
      { path: PROVIDER, source: provider },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /feed 'category' into its hkdfSync info/)
  })

  test('a category-bound info via a helper that itself drops category is a violation', ({
    assert,
  }) => {
    const provider = [
      `const KEK_SALT = Buffer.from('a')`,
      `const INDEX_KEY_SALT = Buffer.from('b')`,
      `async deriveIndexKey(tenantId, category) {`,
      `  return hkdfSync('sha256', k, INDEX_KEY_SALT, indexKeyInfo(tenantId, category), 32)`,
      `}`,
      // The helper is passed category but ignores it, so the injectivity is broken.
      `function indexKeyInfo(tenantId, category) { return Buffer.from(String(tenantId)) }`,
    ].join('\n')
    const problems = auditDomainSeparation([
      { path: SERVICE, source: GOOD_SERVICE },
      { path: PROVIDER, source: provider },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /feed 'category' into its hkdfSync info/)
  })
})
