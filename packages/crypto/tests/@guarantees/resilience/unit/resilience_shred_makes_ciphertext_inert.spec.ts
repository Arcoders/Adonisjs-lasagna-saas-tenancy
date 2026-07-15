import { test } from '@japa/runner'
import {
  RecordingLedger,
  byCategory,
  erasable,
  makeService,
  tenant,
} from '../../../helpers/crypto_shred_fakes.js'
import type { SubjectShreddedEvent } from '../../../../src/events/subject_shredded.js'

const TEST_KEY = 'test-app-key-for-crypto-shred-only!!'

// A crypto-shred destroys the only copy of a (subject × category) DEK,
// so every field ciphertext under it is irrecoverable at once, O(1). The worked
// example: a consent category shreds while a legal-obligation one survives.
test.group('crypto shred: makes ciphertext inert', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  const T = tenant('tenant-1')
  const S = 'renter-42'

  test('shredding a consent category makes its ciphertext undecryptable; a legal-obligation category survives', async ({
    assert,
  }) => {
    const ledger = new RecordingLedger()
    const { service } = makeService({
      erasabilityResolver: byCategory(['marketing']),
      ledger,
    })

    const marketing = await service.encryptField(T, S, 'marketing', 'promo-profile')
    const contract = await service.encryptField(T, S, 'rental-contract', 'signed-contract-#77')

    const result = await service.shred(T, S, 'marketing')
    assert.isTrue(result.shredded)
    assert.isFalse(result.alreadyShredded)

    // The consent category's DEK is gone: its ciphertext is inert (fail-closed).
    await assert.rejects(() => service.decryptField(T, S, 'marketing', marketing), /no live DEK/)
    // The legal-obligation category survived untouched (it is evidence).
    assert.equal(
      await service.decryptField(T, S, 'rental-contract', contract),
      'signed-contract-#77'
    )

    // The two-phase audit recorded exactly one PENDING + one COMMITTED.
    assert.lengthOf(ledger.pending, 1)
    assert.lengthOf(ledger.committed, 1)
    assert.equal(ledger.pending[0].category, 'marketing')
  })

  test('the SubjectShredded event carries the identity and time, never the key', async ({
    assert,
  }) => {
    const events: SubjectShreddedEvent[] = []
    const { service } = makeService({
      erasabilityResolver: erasable(),
      ledger: new RecordingLedger(),
      emitShredded: (e) => events.push(e),
    })
    await service.encryptField(T, S, 'marketing', 'x')
    const result = await service.shred(T, S, 'marketing')

    assert.lengthOf(events, 1)
    const event = events[0]
    assert.deepEqual(
      { tenantId: event.tenantId, subjectId: event.subjectId, category: event.category },
      { tenantId: 'tenant-1', subjectId: S, category: 'marketing' }
    )
    assert.instanceOf(event.occurredAt, Date)
    // No key/secret material anywhere on the event payload.
    const keys = Object.keys(event)
    assert.notInclude(keys, 'dek')
    assert.notInclude(keys, 'key')
    assert.notInclude(keys, 'wrappedDek')
    assert.deepEqual(result.event, event)
  })

  test('a re-provision after a shred inserts a fresh live DEK', async ({ assert }) => {
    const { service, store } = makeService({
      erasabilityResolver: erasable(),
      ledger: new RecordingLedger(),
    })
    await service.encryptField(T, S, 'marketing', 'first-consent')
    await service.shred(T, S, 'marketing')
    assert.isNull(await store.findLive(T, S, 'marketing'))

    // The renter re-grants consent and supplies new data: a fresh live DEK.
    const again = await service.encryptField(T, S, 'marketing', 'second-consent')
    assert.isNotNull(await store.findLive(T, S, 'marketing'))
    assert.equal(await service.decryptField(T, S, 'marketing', again), 'second-consent')
  })

  test('re-shredding an already-shredded category is an idempotent no-op (no ledger row, no event)', async ({
    assert,
  }) => {
    const ledger = new RecordingLedger()
    const events: SubjectShreddedEvent[] = []
    const { service } = makeService({
      erasabilityResolver: erasable(),
      ledger,
      emitShredded: (e) => events.push(e),
    })
    await service.encryptField(T, S, 'marketing', 'x')
    await service.shred(T, S, 'marketing')

    const second = await service.shred(T, S, 'marketing')
    assert.isFalse(second.shredded)
    assert.isTrue(second.alreadyShredded)
    // Still exactly one real shred worth of audit + one event.
    assert.lengthOf(ledger.pending, 1)
    assert.lengthOf(events, 1)
  })
})
