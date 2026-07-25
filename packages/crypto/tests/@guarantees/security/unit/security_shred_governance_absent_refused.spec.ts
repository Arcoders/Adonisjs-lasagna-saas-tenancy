import { test } from '@japa/runner'
import { RecordingLedger, makeService, tenant } from '../../../helpers/crypto_shred_fakes.js'

const TEST_KEY = 'test-app-key-for-crypto-shred-only!!'

// The governance-absent half of the interlock, the red test
// the design names `security_shred_governance_absent_refused.spec.ts`: when no
// erasability resolver is wired (governance is not installed), crypto refuses the shred
// rather than defaulting to erase, and the DEK survives. crypto never decides
// erasability on its own initiative; under-erasing is recoverable, over-erasing is not.
test.group('crypto shred: governance-absent refusal', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  const T = tenant('tenant-1')
  const S = 'renter-42'

  test('governance absent (no resolver wired) refuses the shred and keeps the DEK', async ({
    assert,
  }) => {
    const { service } = makeService({ ledger: new RecordingLedger() })
    const ciphertext = await service.encryptField(T, S, 'marketing', 'x')
    await assert.rejects(() => service.shred(T, S, 'marketing'), /governance absent/)
    // The DEK survived: the value still decrypts.
    assert.equal(await service.decryptField(T, S, 'marketing', ciphertext), 'x')
  })

  test('a governance-absent refusal writes no audit row (nothing destroyed, nothing audited)', async ({
    assert,
  }) => {
    const ledger = new RecordingLedger()
    const { service } = makeService({ ledger })
    await service.encryptField(T, S, 'marketing', 'x')
    await assert.rejects(() => service.shred(T, S, 'marketing'), /governance absent/)
    assert.lengthOf(ledger.pending, 0)
    assert.lengthOf(ledger.committed, 0)
  })
})
