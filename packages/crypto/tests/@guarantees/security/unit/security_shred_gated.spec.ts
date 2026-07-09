import { test } from '@japa/runner'
import {
  RecordingLedger,
  erasable,
  makeService,
  tenant,
} from '../../../helpers/crypto_shred_fakes.js'

const TEST_KEY = 'test-app-key-for-crypto-shred-only!!'

// I7 (§6.6), the two-phase WORM-audit half of the interlock (the legal-hold and
// governance-absent halves live in their own design-named specs,
// security_shred_legal_hold_refused / security_shred_governance_absent_refused). An
// irreversible erasure is NEVER run unaudited: a missing ledger or a failed PENDING
// append aborts before the delete, and a failed COMMITTED mark leaves a detectable
// PENDING row for reconciliation (never a silent success).
test.group('crypto shred — fail-closed two-phase audit (I7)', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  const T = tenant('tenant-1')
  const S = 'renter-42'

  test('no WORM ledger wired refuses the shred (never erase unaudited) and keeps the DEK', async ({
    assert,
  }) => {
    const { service } = makeService({ erasabilityResolver: erasable() })
    const ciphertext = await service.encryptField(T, S, 'marketing', 'x')
    await assert.rejects(() => service.shred(T, S, 'marketing'), /unaudited/)
    assert.equal(await service.decryptField(T, S, 'marketing', ciphertext), 'x')
  })

  test('a failed PENDING append aborts the shred before the delete: nothing destroyed', async ({
    assert,
  }) => {
    const { service } = makeService({
      erasabilityResolver: erasable(),
      ledger: new RecordingLedger({ failAppend: true }),
    })
    const ciphertext = await service.encryptField(T, S, 'marketing', 'x')
    await assert.rejects(() => service.shred(T, S, 'marketing'), /nothing was destroyed/)
    // The DEK is intact: the value still decrypts.
    assert.equal(await service.decryptField(T, S, 'marketing', ciphertext), 'x')
  })

  test('a failed COMMITTED mark is reported, but the erasure already happened (DEK destroyed)', async ({
    assert,
  }) => {
    const ledger = new RecordingLedger({ failCommit: true })
    const { service } = makeService({ erasabilityResolver: erasable(), ledger })
    const ciphertext = await service.encryptField(T, S, 'marketing', 'x')

    await assert.rejects(() => service.shred(T, S, 'marketing'), /unfinalized|COMPLETED/)
    // The DEK is gone (the erasure is irreversible and DID happen)...
    await assert.rejects(() => service.decryptField(T, S, 'marketing', ciphertext), /no live DEK/)
    // ...and a detectable PENDING row remains, un-committed, for reconciliation.
    assert.lengthOf(ledger.pending, 1)
    assert.lengthOf(ledger.committed, 0)
  })
})
