import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import CryptoException from '../../../../src/exceptions/crypto_exception.js'
import {
  erasable,
  makeService,
  notErasable,
  RecordingLedger,
  tenant,
} from '../../../helpers/crypto_shred_fakes.js'

const CAT = 'identity-docs'
const TEST_KEY = 'test-app-key-for-crypto-dryrun-only!'

test.group('behavior — shred dry-run (I6/I7)', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('a live, erasable DEK reports it WOULD shred, and destroys/audits nothing', async ({
    assert,
  }) => {
    const ledger = new RecordingLedger()
    const events: unknown[] = []
    const { service, store } = makeService({
      erasabilityResolver: erasable(),
      ledger,
      emitShredded: (e) => events.push(e),
    })
    const t = tenant(randomUUID())
    await service.encryptField(t, 'renter-1', CAT, 'passport-1')

    const result = await service.shred(t, 'renter-1', CAT, { dryRun: true })
    assert.deepEqual(
      { shredded: result.shredded, alreadyShredded: result.alreadyShredded, dryRun: result.dryRun },
      { shredded: false, alreadyShredded: false, dryRun: true }
    )
    // Nothing destroyed, nothing audited, no event.
    assert.isNotNull(await store.findLive(t, 'renter-1', CAT))
    assert.lengthOf(ledger.pending, 0)
    assert.lengthOf(events, 0)
  })

  test('a missing DEK reports alreadyShredded in a dry run', async ({ assert }) => {
    const { service } = makeService({
      erasabilityResolver: erasable(),
      ledger: new RecordingLedger(),
    })
    const t = tenant(randomUUID())
    const result = await service.shred(t, 'nobody', CAT, { dryRun: true })
    assert.deepEqual(
      { alreadyShredded: result.alreadyShredded, dryRun: result.dryRun },
      { alreadyShredded: true, dryRun: true }
    )
  })

  test('a legal-hold category is REFUSED in a dry run too (the gate runs)', async ({ assert }) => {
    const { service } = makeService({
      erasabilityResolver: notErasable('legal-obligation', new Date('2035-01-01')),
      ledger: new RecordingLedger(),
    })
    const t = tenant(randomUUID())
    await service.encryptField(t, 'renter-1', CAT, 'passport-1')
    await assert.rejects(() => service.shred(t, 'renter-1', CAT, { dryRun: true }), /not erasable/)
  })

  test('a dry run with a live DEK but no ledger wired is refused (unaudited)', async ({
    assert,
  }) => {
    const { service } = makeService({ erasabilityResolver: erasable() }) // no ledger
    const t = tenant(randomUUID())
    await service.encryptField(t, 'renter-1', CAT, 'passport-1')
    try {
      await service.shred(t, 'renter-1', CAT, { dryRun: true })
      assert.fail('expected a shred_unaudited refusal')
    } catch (error) {
      assert.instanceOf(error, CryptoException)
      assert.equal((error as CryptoException).code, 'shred_unaudited')
    }
  })
})
