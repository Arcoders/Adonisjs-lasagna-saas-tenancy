import { test } from '@japa/runner'
import {
  wireResolutionCacheInvalidation,
  RESOLUTION_CACHE_INVALIDATING_EVENTS,
  type ResolutionCacheLike,
} from '../../../../src/providers/resolution_cache_invalidation.js'
import { TenantSuspended, TenantActivated } from '../../../../src/events/index.js'

/**
 * Backs the resolution-cache invalidation wiring that
 * `MultitenancyProvider.ready()` installs. The provider class itself can't be
 * imported in the unit environment (its graph pulls a service that
 * top-level-awaits app boot), so — as with `resetModuleCaches` — the spec
 * exercises the extracted function the provider calls.
 *
 * Regression context: this wiring used to run in `boot()` against the
 * `services/emitter` module, which resolves to `undefined` before the app is
 * booted, so the subscription silently never happened and the cache only ever
 * expired by TTL. The fix moved it to `ready()` with a container-resolved
 * emitter; these tests pin that, given a live emitter, every lifecycle event
 * evicts its tenant.
 */

/** A minimal emitter double that records listeners and can replay an event. */
function fakeEmitter() {
  const handlers = new Map<unknown, Set<(event: unknown) => void>>()
  let unsubscribed = 0
  return {
    on(event: unknown, handler: (event: unknown) => void) {
      let set = handlers.get(event)
      if (!set) handlers.set(event, (set = new Set()))
      set.add(handler)
      return () => {
        set!.delete(handler)
        unsubscribed += 1
      }
    },
    emit(event: unknown, data: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(data)
    },
    listenerCount() {
      let n = 0
      for (const set of handlers.values()) n += set.size
      return n
    },
    unsubscribedCount: () => unsubscribed,
  }
}

/** A cache double that records the ids passed to `delete`. */
function spyCache(): ResolutionCacheLike & { deleted: string[] } {
  const deleted: string[] = []
  return { delete: (id: string) => void deleted.push(id), deleted }
}

test.group('wireResolutionCacheInvalidation', () => {
  test('subscribes exactly one listener per lifecycle event', ({ assert }) => {
    const emitter = fakeEmitter()
    const cache = spyCache()

    wireResolutionCacheInvalidation(emitter as never, cache)

    assert.isAbove(RESOLUTION_CACHE_INVALIDATING_EVENTS.length, 0)
    assert.equal(emitter.listenerCount(), RESOLUTION_CACHE_INVALIDATING_EVENTS.length)
  })

  test('every wired lifecycle event evicts its subject tenant', ({ assert }) => {
    const emitter = fakeEmitter()
    const cache = spyCache()
    wireResolutionCacheInvalidation(emitter as never, cache)

    // Drive each event with a distinct tenant id and assert it was dropped.
    const expected: string[] = []
    RESOLUTION_CACHE_INVALIDATING_EVENTS.forEach((Event, i) => {
      const id = `tenant-${i}`
      expected.push(id)
      emitter.emit(Event, { tenant: { id } })
    })

    assert.deepEqual(cache.deleted, expected)
  })

  test('an event without a tenant id is ignored (no delete, no throw)', ({ assert }) => {
    const emitter = fakeEmitter()
    const cache = spyCache()
    wireResolutionCacheInvalidation(emitter as never, cache)

    emitter.emit(TenantSuspended, {}) // no tenant at all
    emitter.emit(TenantSuspended, { tenant: {} }) // tenant present, id missing
    emitter.emit(TenantSuspended, { tenant: { id: '' } }) // empty id is falsy

    assert.lengthOf(cache.deleted, 0)
  })

  test('the returned teardown removes every listener', ({ assert }) => {
    const emitter = fakeEmitter()
    const cache = spyCache()

    const teardown = wireResolutionCacheInvalidation(emitter as never, cache)
    assert.equal(emitter.listenerCount(), RESOLUTION_CACHE_INVALIDATING_EVENTS.length)

    teardown()

    assert.equal(emitter.listenerCount(), 0)
    assert.equal(emitter.unsubscribedCount(), RESOLUTION_CACHE_INVALIDATING_EVENTS.length)

    // And after teardown, a replayed event is a no-op.
    emitter.emit(TenantActivated, { tenant: { id: 'tenant-x' } })
    assert.lengthOf(cache.deleted, 0)
  })
})
