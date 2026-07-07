import { test } from '@japa/runner'
import TenantMiddlewareRegistry, {
  TENANT_MIDDLEWARE_CONTRACT_VERSION,
  type TenantMiddleware,
  type TenantMiddlewareEntry,
  type TenantMiddlewareScope,
} from '../../../../src/services/tenant_middleware_registry.js'
import { middlewareName } from '../../../../src/sdk/brands.js'

const mw = (id: string): TenantMiddleware =>
  ({ id, handle: () => {} }) as unknown as TenantMiddleware

function entry(
  name: string,
  id: string,
  opts: { scope?: TenantMiddlewareScope; order?: number; contractVersion?: number } = {}
): TenantMiddlewareEntry {
  return { kind: 'middleware', name: middlewareName(name), middleware: mw(id), ...opts }
}

function ids(list: readonly TenantMiddleware[]): string[] {
  return list.map((m) => (m as unknown as { id: string }).id)
}

test.group('TenantMiddlewareRegistry — registration', () => {
  test('exposes the contract version', ({ assert }) => {
    assert.equal(new TenantMiddlewareRegistry().contractVersion, TENANT_MIDDLEWARE_CONTRACT_VERSION)
  })

  test('register / has / list / unregister', ({ assert }) => {
    const reg = new TenantMiddlewareRegistry()
    reg.register(entry('mw_a', 'a'))
    reg.register(entry('mw_b', 'b'))
    assert.deepEqual(reg.list(), ['mw_a', 'mw_b'])
    assert.isTrue(reg.has(middlewareName('mw_a')))
    assert.isTrue(reg.unregister(middlewareName('mw_a')))
    assert.deepEqual(reg.list(), ['mw_b'])
  })

  test('duplicate name throws a typed PluginMiddlewareException (500)', ({ assert }) => {
    const reg = new TenantMiddlewareRegistry()
    reg.register(entry('dup', 'x'))
    try {
      reg.register(entry('dup', 'y'))
      assert.fail('expected a throw')
    } catch (err: any) {
      assert.equal(err.code, 'E_PLUGIN_MIDDLEWARE')
      assert.equal(err.status, 500)
    }
  })

  test('a middleware built for a NEWER contract is rejected at registration', ({ assert }) => {
    const reg = new TenantMiddlewareRegistry()
    assert.throws(
      () =>
        reg.register(
          entry('too_new', 'z', { contractVersion: TENANT_MIDDLEWARE_CONTRACT_VERSION + 1 })
        ),
      /requires extension contract/
    )
  })
})

test.group('TenantMiddlewareRegistry — resolve (scope + order)', () => {
  test('resolve filters by scope; default scope is tenant', ({ assert }) => {
    const reg = new TenantMiddlewareRegistry()
    reg.register(entry('t1', 't1')) // default tenant
    reg.register(entry('c1', 'c1', { scope: 'central' }))
    reg.register(entry('u1', 'u1', { scope: 'universal' }))

    assert.deepEqual(ids(reg.resolve('tenant')), ['t1'])
    assert.deepEqual(ids(reg.resolve('central')), ['c1'])
    assert.deepEqual(ids(reg.resolve('universal')), ['u1'])
  })

  test('resolve orders by ascending order, ties by registration order', ({ assert }) => {
    const reg = new TenantMiddlewareRegistry()
    reg.register(entry('late', 'late', { order: 10 }))
    reg.register(entry('early', 'early', { order: 1 }))
    reg.register(entry('tie_a', 'tie_a')) // order 0
    reg.register(entry('tie_b', 'tie_b')) // order 0

    assert.deepEqual(ids(reg.resolve('tenant')), ['tie_a', 'tie_b', 'early', 'late'])
  })

  test('resolve returns an empty array for a scope no plugin targeted', ({ assert }) => {
    assert.deepEqual(new TenantMiddlewareRegistry().resolve('central'), [])
  })
})
