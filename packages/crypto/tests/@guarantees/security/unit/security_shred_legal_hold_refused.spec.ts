import { test } from '@japa/runner'
import { RecordingLedger, notErasable, tenant } from '../../../helpers/crypto_shred_fakes.js'
import { makeService } from '../../../helpers/crypto_shred_fakes.js'

const TEST_KEY = 'test-app-key-for-crypto-shred-only!!'

// I7 (§6.6, foundation §3), the legal-hold half of the interlock — the RED test the
// design names `security_shred_legal_hold_refused.spec.ts`: a `legal-obligation`
// category still within its retention window is REFUSED, the DEK survives, and the
// governance gate runs FIRST so a refused shred writes no audit row. Over-erasing a
// record the law requires kept is an irreversible violation in the other direction.
test.group('crypto shred — legal-hold refusal (I7)', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  const T = tenant('tenant-1')
  const S = 'renter-42'

  test('a legal-obligation category in retention is refused and kept', async ({ assert }) => {
    const retentionUntil = new Date('2035-01-01T00:00:00.000Z')
    const { service } = makeService({
      erasabilityResolver: notErasable('legal-obligation', retentionUntil),
      ledger: new RecordingLedger(),
    })
    const contract = await service.encryptField(T, S, 'rental-contract', 'signed')
    await assert.rejects(() => service.shred(T, S, 'rental-contract'), /not erasable/)
    // The DEK survived: the signed contract still decrypts (it is evidence).
    assert.equal(await service.decryptField(T, S, 'rental-contract', contract), 'signed')
  })

  test('the governance gate is the FIRST awaited call: a refused shred writes NO ledger row', async ({
    assert,
  }) => {
    const ledger = new RecordingLedger()
    const { service } = makeService({ erasabilityResolver: notErasable(), ledger })
    await service.encryptField(T, S, 'rental-contract', 'signed')
    await assert.rejects(() => service.shred(T, S, 'rental-contract'))
    // Refused before any audit row is written (gate-first, no default-to-erase).
    assert.lengthOf(ledger.pending, 0)
    assert.lengthOf(ledger.committed, 0)
  })
})
