import { test } from '@japa/runner'
import {
  RecordingLedger,
  erasable,
  makeService,
  notErasable,
  tenant,
} from '../../../helpers/crypto_shred_fakes.js'

const TEST_KEY = 'test-app-key-for-crypto-shred-only!!'

// I7 (§6.6, foundation §3): a shred is gated by governance's legalBasis and by a
// fail-closed WORM audit. A legal-obligation category in retention, an absent
// governance resolver, or an unauditable erasure are all REFUSED, and the DEK
// survives. Over-erasing is irreversible; under-erasing is recoverable.
test.group('crypto shred — governance + audit gate (I7)', (group) => {
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

  test('a legal-obligation category in retention is refused and kept', async ({ assert }) => {
    const retentionUntil = new Date('2035-01-01T00:00:00.000Z')
    const { service } = makeService({
      erasabilityResolver: notErasable('legal-obligation', retentionUntil),
      ledger: new RecordingLedger(),
    })
    const contract = await service.encryptField(T, S, 'rental-contract', 'signed')
    await assert.rejects(() => service.shred(T, S, 'rental-contract'), /not erasable/)
    assert.equal(await service.decryptField(T, S, 'rental-contract', contract), 'signed')
  })

  test('the governance gate is the FIRST awaited call: a refused shred writes NO ledger row', async ({
    assert,
  }) => {
    const ledger = new RecordingLedger()
    const { service } = makeService({ erasabilityResolver: notErasable(), ledger })
    await service.encryptField(T, S, 'rental-contract', 'signed')
    await assert.rejects(() => service.shred(T, S, 'rental-contract'))
    // Refused before any audit row is written.
    assert.lengthOf(ledger.pending, 0)
    assert.lengthOf(ledger.committed, 0)
  })

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
