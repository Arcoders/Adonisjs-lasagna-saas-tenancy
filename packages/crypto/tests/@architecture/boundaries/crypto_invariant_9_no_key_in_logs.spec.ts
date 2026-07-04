import { test } from '@japa/runner'
// The I9 guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise the no-key-in-log/error rule (T11): raw DEK/KEK/index-key bytes
// must never enter a log line or an error body.
import { auditNoKeyMaterialInSinks } from '../../../../../scripts/check-crypto-invariant-9.mjs'

const P = 'packages/crypto/src/services/x.ts'

test.group('architectural — I9 no key material in logs/errors', () => {
  test('naming a key in a message string, or logging its length, is not a leak', ({ assert }) => {
    const source = [
      `throw new CryptoException('keyprovider_missing', '[crypto] APP_KEY is not set; set it.')`,
      'throw new CryptoException(`dek_invalid`, `a DEK must be ${DEK_BYTES} bytes, got ${dek.length}.`)',
      'logger.info(`index key is ${indexKey.byteLength} bytes`)',
      `const kek = deriveKek(appKey, tenantId)`, // not a sink
      `const wrapped = await this.wrapDek(tenantId, dek)`, // not a sink
    ].join('\n')
    assert.deepEqual(auditNoKeyMaterialInSinks([{ path: P, source }]), [])
  })

  test('interpolating the raw DEK into an error body is a violation', ({ assert }) => {
    const source = ['throw new CryptoException(`bad`, `dek was ${dek} for ${subject}`)'].join('\n')
    const problems = auditNoKeyMaterialInSinks([{ path: P, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /raw key material 'dek'/)
  })

  test('logging a KEK via toString is a violation', ({ assert }) => {
    const source = ['logger.debug(`kek=${kek.toString("hex")}`)'].join('\n')
    const problems = auditNoKeyMaterialInSinks([{ path: P, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /raw key material 'kek'/)
  })

  test('console-logging APP_KEY (the value) is a violation', ({ assert }) => {
    const source = ['console.log(appKey)'].join('\n')
    const problems = auditNoKeyMaterialInSinks([{ path: P, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /raw key material 'appKey'/)
  })

  test('an index key concatenated into a warn sink is a violation', ({ assert }) => {
    const source = ["warn('index=' + indexKey)"].join('\n')
    const problems = auditNoKeyMaterialInSinks([{ path: P, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /raw key material 'indexKey'/)
  })

  test('a multi-line error template that interpolates a key is caught', ({ assert }) => {
    const source = [
      'throw new CryptoException(',
      '  `bad`,',
      '  `cannot open ${dek} for the row`',
      ')',
    ].join('\n')
    const problems = auditNoKeyMaterialInSinks([{ path: P, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /raw key material 'dek'/)
  })

  test('a key mentioned only in a comment is not a leak', ({ assert }) => {
    const source = [
      `// never do logger.info(\`\${dek}\`) here`,
      `return sealV2WithKey(plaintext, dek, keyId)`, // not a sink
    ].join('\n')
    assert.deepEqual(auditNoKeyMaterialInSinks([{ path: P, source }]), [])
  })

  test('the non-secret kekId tag and Dek/Kek method names are not flagged', ({ assert }) => {
    const source = [
      'logger.info(`rotated to ${kekId} via unwrapDek/wrapDek`)',
      'throw new CryptoException(`e`, `deriveKek failed for ${tenantId}`)',
    ].join('\n')
    assert.deepEqual(auditNoKeyMaterialInSinks([{ path: P, source }]), [])
  })

  test('a raw key written to process.stdout is a violation', ({ assert }) => {
    const source = ['process.stdout.write(`${dek.toString("hex")}\\n`)'].join('\n')
    const problems = auditNoKeyMaterialInSinks([{ path: P, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /raw key material 'dek'/)
  })

  test('a raw key in a bare thrown template string is a violation', ({ assert }) => {
    const source = ['throw `cannot open ${dek} for the row`'].join('\n')
    const problems = auditNoKeyMaterialInSinks([{ path: P, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /thrown template string references raw key material 'dek'/)
  })

  test('a hardcoded key literal (the config-literal clause) is a violation', ({ assert }) => {
    for (const decl of [
      `const dek = Buffer.from('00112233445566778899aabbccddeeff', 'hex')`,
      `const appKey = 'super-secret-app-key-value'`,
      `export const indexKey = Buffer.from('deadbeefdeadbeef')`,
      `const kek = process.env.KEK ?? 'hardcoded-fallback-kek'`,
    ]) {
      const problems = auditNoKeyMaterialInSinks([{ path: P, source: decl }])
      assert.lengthOf(problems, 1, `should flag: ${decl}`)
      assert.match(problems[0], /hardcoded key literal/)
    }
  })

  test('legitimate key derivation / env reads / public salts are not hardcoded-key violations', ({
    assert,
  }) => {
    const source = [
      `const appKey = process.env.APP_KEY`,
      `const kek = deriveKek(appKey, tenantId)`,
      `const dek = Buffer.from(openV2WithKey(wrapped.ciphertext, kek), 'base64')`,
      `const KEK_SALT = Buffer.from('lasagna:crypto:kek:v1')`,
      `const INDEX_KEY_SALT = Buffer.from('lasagna:crypto:blind-index:v1')`,
    ].join('\n')
    assert.deepEqual(auditNoKeyMaterialInSinks([{ path: P, source }]), [])
  })
})
