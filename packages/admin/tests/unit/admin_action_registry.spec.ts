import { test } from '@japa/runner'
// Import the registry from its own module, NOT the package barrel: the barrel
// pulls AdminController, whose module graph eagerly imports a logger that
// top-level-awaits `app.booted(...)` and crashes outside an Ignitor. The
// dispatch controller (which imports the booted `/services` barrel) is exercised
// by the demo e2e suite, not here.
import { AdminActionRegistry, isSafeActionName } from '../../src/admin_action_registry.js'
import { ADMIN_CONTRACT_VERSION } from '../../src/constants.js'

function action(name: string, contractVersion: number | undefined = ADMIN_CONTRACT_VERSION) {
  return { name, description: name, contractVersion, execute: async () => ({ ran: name }) }
}

test.group('AdminActionRegistry', () => {
  test('register / get / has / list round-trip', ({ assert }) => {
    const reg = new AdminActionRegistry()
    reg.register(action('reindex')).register(action('purge_cache'))
    assert.isTrue(reg.has('reindex'))
    assert.equal(reg.get('purge_cache')?.description, 'purge_cache')
    assert.deepEqual([...reg.list()].sort(), ['purge_cache', 'reindex'])
    assert.equal(reg.contractVersion, ADMIN_CONTRACT_VERSION)
  })

  test('rejects an unsafe or duplicate name', ({ assert }) => {
    const reg = new AdminActionRegistry()
    reg.register(action('ok'))
    assert.throws(() => reg.register(action('ok')), /already registered/)
    assert.throws(() => reg.register(action('bad name')), /invalid/)
    assert.throws(() => reg.register(action("x'; DROP")), /invalid/)
  })

  test('rejects an action built for a NEWER contract', ({ assert }) => {
    const reg = new AdminActionRegistry()
    assert.throws(
      () => reg.register(action('future', ADMIN_CONTRACT_VERSION + 1)),
      /requires extension contract/
    )
    assert.isFalse(reg.has('future'))
  })

  test('clear empties the registry', ({ assert }) => {
    const reg = new AdminActionRegistry()
    reg.register(action('a'))
    reg.clear()
    assert.lengthOf(reg.list(), 0)
  })

  test('isSafeActionName guards URL-unsafe names', ({ assert }) => {
    assert.isTrue(isSafeActionName('reindex_search-2'))
    assert.isFalse(isSafeActionName('a/b'))
    assert.isFalse(isSafeActionName(''))
    assert.isFalse(isSafeActionName('a'.repeat(64)))
  })
})
