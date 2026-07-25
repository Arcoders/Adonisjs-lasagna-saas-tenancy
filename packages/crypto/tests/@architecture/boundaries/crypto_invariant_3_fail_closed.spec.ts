import { test } from '@japa/runner'
// This guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise fail-closed reads (strict openV2WithKey, no lenient catch) and
// the DB-level ciphertext CHECK backstop that rejects a raw plaintext write to an encrypted column.
import { auditFailClosed } from '../../../../../scripts/check-crypto-invariant-3.mjs'

const SERVICE_PATH = 'packages/crypto/src/services/crypto_service.ts'
const HELPER_PATH = 'packages/crypto/src/schema/encrypted_column.ts'

/** A compliant service: decryptField opens strictly and never catches. */
const GOOD_SERVICE = [
  `import { openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'`,
  `export default class CryptoService {`,
  `  async decryptField(tenant, subjectId, category, ciphertext) {`,
  `    const live = await this.#liveDek(tenant, subjectId, category)`,
  `    if (!live) throw new CryptoException('dek_missing', 'no live DEK')`,
  `    return openV2WithKey(ciphertext, live.dek)`,
  `  }`,
  `}`,
].join('\n')

/** A compliant helper: emits an ALTER TABLE ... CHECK accepting both prefixes. */
const GOOD_HELPER = [
  `export const CIPHERTEXT_PREFIXES = ['enc_v2:', 'enc_v1:']`,
  `export function encryptedColumnCheckSql(table, column) {`,
  `  return 'ALTER TABLE "' + table + '" ADD CONSTRAINT "' + table + '_' + column +`,
  `    '_is_ciphertext" CHECK ("' + column + '" IS NULL OR left("' + column +`,
  `    '", 7) IN (' + "'enc_v2:', 'enc_v1:'" + '))'`,
  `}`,
].join('\n')

const REPO_PATH = 'packages/crypto/src/services/encrypted_repository.ts'
const MODEL_PATH = 'packages/crypto/src/models/encrypted_columns.ts'
const MIXIN_PATH = 'packages/crypto/src/models/with_encrypted_fields.ts'

/** The decorator read-path frames, each delegating to the strict choke point, no catch. */
const GOOD_REPO = [
  `export default class EncryptedRepository {`,
  `  async decrypt(subject, category, ciphertext) {`,
  `    return this.#crypto.decryptField(await this.#tenant(), subject, category, ciphertext)`,
  `  }`,
  `}`,
].join('\n')

const GOOD_DECRYPT_MODEL = [
  `export async function decryptModelFields(repo, meta, model) {`,
  `  for (const f of meta.encrypted) {`,
  `    const value = model.$attributes[f.column]`,
  `    if (value === null || value === undefined) continue`,
  `    model.$setAttribute(f.column, await repo.decrypt(f.subject(model), f.category, String(value)))`,
  `  }`,
  `  model.$hydrateOriginals()`,
  `}`,
].join('\n')

const GOOD_BOOT = [
  `export function withEncryptedFields(Base) {`,
  `  class WithEncryptedFields extends Base {`,
  `    static boot() {`,
  `      const decryptHook = async (model) => { await decryptModelFields(await repo(), meta, model) }`,
  `      this.after('find', decryptHook)`,
  `      this.after('fetch', async (models) => { for (const m of models) await decryptHook(m) })`,
  `    }`,
  `  }`,
  `  return WithEncryptedFields`,
  `}`,
].join('\n')

function goodFiles() {
  return [
    { path: SERVICE_PATH, source: GOOD_SERVICE },
    { path: HELPER_PATH, source: GOOD_HELPER },
  ]
}

/** The full read path (all four frames) + the CHECK helper, all compliant. */
function goodReadPath() {
  return [
    { path: SERVICE_PATH, source: GOOD_SERVICE },
    { path: REPO_PATH, source: GOOD_REPO },
    { path: MODEL_PATH, source: GOOD_DECRYPT_MODEL },
    { path: MIXIN_PATH, source: GOOD_BOOT },
    { path: HELPER_PATH, source: GOOD_HELPER },
  ]
}

test.group('architectural: fail-closed reads and the DB CHECK backstop', () => {
  test('a strict-read service + prefix CHECK helper pass', ({ assert }) => {
    assert.deepEqual(auditFailClosed(goodFiles()), [])
  })

  test('the full read path (all frames, no catch) passes', ({ assert }) => {
    assert.deepEqual(auditFailClosed(goodReadPath()), [])
  })

  test('a lenient catch in decryptModelFields (the per-row loop) is caught', ({ assert }) => {
    const model = [
      `export async function decryptModelFields(repo, meta, model) {`,
      `  for (const f of meta.encrypted) {`,
      `    try { model.$setAttribute(f.column, await repo.decrypt(f.subject(model), f.category, 'x')) }`,
      `    catch { /* skip the bad row, keep the batch going */ }`,
      `  }`,
      `}`,
    ].join('\n')
    const files = goodReadPath().map((f) => (f.path === MODEL_PATH ? { ...f, source: model } : f))
    const problems = auditFailClosed(files)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /decryptModelFields contains a catch/)
  })

  test('a lenient catch in EncryptedRepository.decrypt (the choke point) is caught', ({
    assert,
  }) => {
    const repo = [
      `export default class EncryptedRepository {`,
      `  async decrypt(subject, category, ciphertext) {`,
      `    try { return this.#crypto.decryptField(await this.#tenant(), subject, category, ciphertext) }`,
      `    catch { return ciphertext }`,
      `  }`,
      `}`,
    ].join('\n')
    const files = goodReadPath().map((f) => (f.path === REPO_PATH ? { ...f, source: repo } : f))
    const problems = auditFailClosed(files)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /decrypt contains a catch/)
  })

  test('a lenient catch in the mixin decrypt hooks (boot) is caught', ({ assert }) => {
    const boot = [
      `export function withEncryptedFields(Base) {`,
      `  class WithEncryptedFields extends Base {`,
      `    static boot() {`,
      `      const decryptHook = async (model) => {`,
      `        try { await decryptModelFields(await repo(), meta, model) } catch { /* swallow */ }`,
      `      }`,
      `      this.after('find', decryptHook)`,
      `    }`,
      `  }`,
      `  return WithEncryptedFields`,
      `}`,
    ].join('\n')
    const files = goodReadPath().map((f) => (f.path === MIXIN_PATH ? { ...f, source: boot } : f))
    const problems = auditFailClosed(files)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /boot contains a catch/)
  })

  test('a repository that stops delegating to decryptField is caught', ({ assert }) => {
    const repo = [
      `export default class EncryptedRepository {`,
      `  async decrypt(subject, category, ciphertext) {`,
      `    return ciphertext`,
      `  }`,
      `}`,
    ].join('\n')
    const files = goodReadPath().map((f) => (f.path === REPO_PATH ? { ...f, source: repo } : f))
    const problems = auditFailClosed(files)
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /must delegate to decryptField/)
  })

  test('decryptField that skips openV2WithKey is a violation', ({ assert }) => {
    const source = [
      `export default class CryptoService {`,
      `  async decryptField(tenant, subjectId, category, ciphertext) {`,
      `    return ciphertext`,
      `  }`,
      `}`,
    ].join('\n')
    const problems = auditFailClosed([
      { path: SERVICE_PATH, source },
      { path: HELPER_PATH, source: GOOD_HELPER },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /STRICT openV2WithKey/)
  })

  test('decryptField that catches the strict throw is a lenient carve-out violation', ({
    assert,
  }) => {
    const source = [
      `import { openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'`,
      `export default class CryptoService {`,
      `  async decryptField(tenant, subjectId, category, ciphertext) {`,
      `    try { return openV2WithKey(ciphertext, dek) } catch { return ciphertext }`,
      `  }`,
      `}`,
    ].join('\n')
    const problems = auditFailClosed([
      { path: SERVICE_PATH, source },
      { path: HELPER_PATH, source: GOOD_HELPER },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /catch/)
  })

  test('a missing CHECK helper is a violation (the write backstop is absent)', ({ assert }) => {
    const problems = auditFailClosed([{ path: SERVICE_PATH, source: GOOD_SERVICE }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /ciphertext CHECK helper/)
  })

  test('a CHECK helper that only accepts enc_v2 (drops enc_v1) is a violation', ({ assert }) => {
    const helper = [
      `export function encryptedColumnCheckSql(table, column) {`,
      `  return 'ALTER TABLE x ADD CONSTRAINT c CHECK (col IS NULL OR ' + "'enc_v2:'" + ')'`,
      `}`,
    ].join('\n')
    const problems = auditFailClosed([
      { path: SERVICE_PATH, source: GOOD_SERVICE },
      { path: HELPER_PATH, source: helper },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /enc_v1:/)
  })

  test('a doc-comment naming catch / a prefix is not a false positive', ({ assert }) => {
    const service = [
      `import { openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'`,
      `export default class CryptoService {`,
      `  // We never catch the strict throw here (fail-closed).`,
      `  async decryptField(tenant, subjectId, category, ciphertext) {`,
      `    return openV2WithKey(ciphertext, dek)`,
      `  }`,
      `}`,
    ].join('\n')
    assert.deepEqual(
      auditFailClosed([
        { path: SERVICE_PATH, source: service },
        { path: HELPER_PATH, source: GOOD_HELPER },
      ]),
      []
    )
  })

  test('a missing service file is a violation', ({ assert }) => {
    const problems = auditFailClosed([{ path: HELPER_PATH, source: GOOD_HELPER }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0]!, /strict field-decrypt path/)
  })
})
