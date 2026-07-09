import { test } from '@japa/runner'
import CryptoService from '../../../../src/services/crypto_service.js'
import EnvKeyProvider from '../../../../src/services/env_key_provider.js'
import InMemoryWrappedDekStore from '../../../../src/testing/in_memory_wrapped_dek_store.js'
import { RecordingLedger, erasable, tenant } from '../../../helpers/crypto_shred_fakes.js'
import type { SubjectShreddedEvent } from '../../../../src/events/subject_shredded.js'
import type { WrappedDekStore } from '../../../../src/services/wrapped_dek_store.js'

const TEST_KEY = 'test-app-key-for-crypto-race-only!!!'
const T = tenant('tenant-1')
const S = 'renter-42'
const CAT = 'marketing'

/**
 * Wrap a real in-memory store so `shredLive` reports it tombstoned NOTHING — the exact
 * signal that a concurrent shred won the race and already destroyed the DEK between our
 * `findLive` and our `shredLive` (only reachable in the Redis-down degraded lock mode).
 */
function storeLosingTheShredRace(inner: WrappedDekStore): WrappedDekStore {
  return {
    findLive: (t, s, c) => inner.findLive(t, s, c),
    listLive: (t, o) => inner.listLive(t, o),
    rewrap: (t, id, w, k) => inner.rewrap(t, id, w, k),
    insert: (t, r) => inner.insert(t, r),
    shredLive: async () => false,
  }
}

// crypto §6.6 / I6: under contention the shred serializes on the operation lock, but if
// Redis is down the lock degrades to fail-open. There, `shredLive()` is the authoritative
// backstop: only the caller that actually tombstoned the live row writes the COMMITTED
// marker and emits SubjectShredded. A loser (shredLive → 0 rows) returns alreadyShredded
// and never double-audits or double-emits; its PENDING row is a detectable orphan.
test.group('crypto shred — concurrent-race authority (I6, WS-0.1)', (group) => {
  group.each.setup(() => {
    process.env.APP_KEY = TEST_KEY
  })
  group.each.teardown(() => {
    delete process.env.APP_KEY
  })

  test('losing the tombstone race returns alreadyShredded with no double audit or emit', async ({
    assert,
  }) => {
    const inner = new InMemoryWrappedDekStore()
    const ledger = new RecordingLedger()
    const emitted: SubjectShreddedEvent[] = []
    const service = new CryptoService({
      keyProvider: new EnvKeyProvider(),
      store: storeLosingTheShredRace(inner),
      erasabilityResolver: erasable(),
      ledger,
      emitShredded: (e) => emitted.push(e),
    })

    // Provision a live DEK (findLive will see it), then shred while shredLive reports 0 rows.
    await service.encryptField(T, S, CAT, 'x')
    const result = await service.shred(T, S, CAT)

    assert.deepEqual(result, { shredded: false, alreadyShredded: true })
    assert.lengthOf(emitted, 0) // never emits for a lost race
    assert.lengthOf(ledger.committed, 0) // never writes the COMMITTED marker
    assert.lengthOf(ledger.pending, 1) // the orphan PENDING is detectable (reconciliation)
  })

  test('winning the race writes exactly one PENDING + COMMITTED and emits once', async ({
    assert,
  }) => {
    const store = new InMemoryWrappedDekStore()
    const ledger = new RecordingLedger()
    const emitted: SubjectShreddedEvent[] = []
    const service = new CryptoService({
      keyProvider: new EnvKeyProvider(),
      store,
      erasabilityResolver: erasable(),
      ledger,
      emitShredded: (e) => emitted.push(e),
    })

    await service.encryptField(T, S, CAT, 'x')
    const result = await service.shred(T, S, CAT)

    assert.isTrue(result.shredded)
    assert.lengthOf(ledger.pending, 1)
    assert.lengthOf(ledger.committed, 1)
    assert.lengthOf(emitted, 1)

    // Re-shredding is an idempotent no-op: no second audit, no second event.
    const again = await service.shred(T, S, CAT)
    assert.deepEqual(again, { shredded: false, alreadyShredded: true })
    assert.lengthOf(ledger.pending, 1)
    assert.lengthOf(emitted, 1)
  })
})
