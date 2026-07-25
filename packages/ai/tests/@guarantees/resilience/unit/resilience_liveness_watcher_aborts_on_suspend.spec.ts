import { test } from '@japa/runner'
import type { Emitter } from '@adonisjs/core/events'
import { TenantSuspended, TenantDeleted } from '@adonisjs-lasagna/saas-tenancy/events'
import TenantLivenessWatcher, {
  AI_LIVENESS_REVOKING_EVENTS,
  wireAiTenantLiveness,
} from '../../../../src/services/tenant_liveness_watcher.js'

/**
 * A tenant suspended mid-stream is a TOCTOU hazard: the watcher turns a tenant
 * lifecycle event into an abort of exactly that tenant's live streams, with no
 * leaks (dispose prunes) and reversible wiring (the teardown removes every listener).
 */

type Handler = (event: unknown) => void

/** A recording fake emitter honouring the on() => off() contract. */
function fakeEmitter() {
  const handlers = new Map<unknown, Handler>()
  const emitter = {
    on(event: unknown, handler: Handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  } as unknown as Emitter<any>
  const fire = (event: unknown, payload: unknown) => handlers.get(event)?.(payload)
  return { emitter, handlers, fire }
}

test.group('TenantLivenessWatcher', () => {
  test('suspending a tenant aborts all and only that tenant’s signals', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    const { emitter, fire } = fakeEmitter()
    wireAiTenantLiveness(emitter, watcher)

    const a1 = watcher.acquire('tenant-a')
    const a2 = watcher.acquire('tenant-a')
    const b1 = watcher.acquire('tenant-b')

    fire(TenantSuspended, { tenant: { id: 'tenant-a' } })

    assert.isTrue(a1.signal.aborted)
    assert.isTrue(a2.signal.aborted)
    assert.isFalse(b1.signal.aborted)
  })

  test('deletion revokes too (both lifecycle events are wired)', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    const { emitter, handlers, fire } = fakeEmitter()
    wireAiTenantLiveness(emitter, watcher)

    assert.lengthOf(AI_LIVENESS_REVOKING_EVENTS, 2)
    for (const Event of AI_LIVENESS_REVOKING_EVENTS) {
      assert.isTrue(handlers.has(Event), `missing subscription for ${Event.name}`)
    }

    const handle = watcher.acquire('tenant-a')
    fire(TenantDeleted, { tenant: { id: 'tenant-a' } })
    assert.isTrue(handle.signal.aborted)
  })

  test('a disposed stream can no longer be aborted and leaves no residue', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()

    const handle = watcher.acquire('tenant-a')
    handle.dispose()
    handle.dispose() // idempotent

    assert.equal(watcher.watchedTenantCount(), 0, 'dispose must prune the per-tenant set')
    assert.equal(watcher.revoke('tenant-a'), 0)
    assert.isFalse(handle.signal.aborted)
  })

  test('revoke reports how many streams it aborted and clears the tenant', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    watcher.acquire('tenant-a')
    watcher.acquire('tenant-a')

    assert.equal(watcher.revoke('tenant-a'), 2)
    assert.equal(watcher.watchedTenantCount(), 0)
    assert.equal(watcher.revoke('tenant-a'), 0, 'a second revoke finds nothing')
  })

  test('an event without a tenant id is ignored', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    const { emitter, fire } = fakeEmitter()
    wireAiTenantLiveness(emitter, watcher)

    const handle = watcher.acquire('tenant-a')
    fire(TenantSuspended, {})
    fire(TenantSuspended, { tenant: {} })
    assert.isFalse(handle.signal.aborted)
  })

  test('the teardown removes every listener', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    const { emitter, handlers } = fakeEmitter()
    const teardown = wireAiTenantLiveness(emitter, watcher)

    assert.equal(handlers.size, AI_LIVENESS_REVOKING_EVENTS.length)
    teardown()
    assert.equal(handlers.size, 0)
  })
})
