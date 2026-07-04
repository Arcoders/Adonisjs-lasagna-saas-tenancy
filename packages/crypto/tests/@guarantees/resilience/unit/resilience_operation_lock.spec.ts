import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import {
  erasable,
  makeService,
  RecordingLedger,
  RecordingLock,
  tenant,
} from '../../../helpers/crypto_shred_fakes.js'

const CAT = 'identity-docs'
const TEST_KEY = 'test-app-key-for-crypto-lock-only!!!'

test.group('resilience — per-tenant operation lock (I10)', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('provisioning a DEK runs under the lock; reusing a live DEK does not', async ({
    assert,
  }) => {
    const rec = new RecordingLock()
    const { service } = makeService({ withLock: rec.lock })
    const t = tenant(randomUUID())

    await service.encryptField(t, 'renter-1', CAT, 'passport-1') // provisions → 1 lock
    assert.equal(rec.acquisitions, 1)

    await service.encryptField(t, 'renter-1', CAT, 'passport-1-again') // reuses → no lock
    assert.equal(rec.acquisitions, 1)
  })

  test('shred runs under the lock', async ({ assert }) => {
    const rec = new RecordingLock()
    const { service } = makeService({
      erasabilityResolver: erasable(),
      ledger: new RecordingLedger(),
      withLock: rec.lock,
    })
    const t = tenant(randomUUID())

    await service.encryptField(t, 'renter-1', CAT, 'passport-1') // provision → 1
    const result = await service.shred(t, 'renter-1', CAT) // shred → 2
    assert.isTrue(result.shredded)
    assert.equal(rec.acquisitions, 2)
  })

  test('a dry-run shred does NOT take the lock (it destroys nothing)', async ({ assert }) => {
    const rec = new RecordingLock()
    const { service, store } = makeService({
      erasabilityResolver: erasable(),
      ledger: new RecordingLedger(),
      withLock: rec.lock,
    })
    const t = tenant(randomUUID())

    await service.encryptField(t, 'renter-1', CAT, 'passport-1') // provision → 1
    const dry = await service.shred(t, 'renter-1', CAT, { dryRun: true })
    assert.equal(rec.acquisitions, 1, 'no lock acquired for a dry run')
    assert.isTrue(dry.dryRun)
    assert.isFalse(dry.alreadyShredded) // a live DEK exists ⇒ would shred
    assert.isNotNull(await store.findLive(t, 'renter-1', CAT), 'the DEK is untouched')
  })

  test('concurrent first-writes to one (subject × category) resolve to ONE DEK, no conflict', async ({
    assert,
  }) => {
    const rec = new RecordingLock()
    const { service, store } = makeService({ withLock: rec.lock })
    const t = tenant(randomUUID())

    // Two concurrent first-writes: the lock + the re-check inside it collapse the
    // race to one live DEK (the loser reuses the winner's), never a dek_conflict.
    const [a, b] = await Promise.all([
      service.encryptField(t, 'renter-2', CAT, 'value-A'),
      service.encryptField(t, 'renter-2', CAT, 'value-B'),
    ])

    assert.equal(await service.decryptField(t, 'renter-2', CAT, a), 'value-A')
    assert.equal(await service.decryptField(t, 'renter-2', CAT, b), 'value-B')

    // Exactly one live DEK row exists for the pair (I10).
    const rows = await store.listLive(t)
    assert.lengthOf(
      rows.filter((r) => r.subjectId === 'renter-2' && r.category === CAT),
      1
    )
  })

  test('an absent lock is a safe degraded mode: encrypt/shred still work', async ({ assert }) => {
    // No withLock wired ⇒ the partial UNIQUE / idempotent shred are the backstop.
    const { service } = makeService({
      erasabilityResolver: erasable(),
      ledger: new RecordingLedger(),
    })
    const t = tenant(randomUUID())
    const ct = await service.encryptField(t, 'renter-1', CAT, 'passport-1')
    assert.equal(await service.decryptField(t, 'renter-1', CAT, ct), 'passport-1')
    assert.isTrue((await service.shred(t, 'renter-1', CAT)).shredded)
  })
})
