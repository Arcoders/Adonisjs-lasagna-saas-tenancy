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
})
