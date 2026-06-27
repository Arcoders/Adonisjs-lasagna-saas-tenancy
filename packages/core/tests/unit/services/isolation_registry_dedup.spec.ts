import { test } from '@japa/runner'
import IsolationDriverRegistry from '../../../src/services/isolation/registry.js'
import TenantResolverRegistry from '../../../src/services/resolvers/registry.js'

/**
 * WS-5 / driver-registries-missing-name-dedup-guard.
 *
 * register() used to Map.set() blindly, so an empty name or a duplicate name
 * silently shadowed an existing driver/resolver and re-pointed routing with no
 * signal. The guard refuses both unless { override: true }.
 *
 * RED (pre-fix): an empty name and a duplicate were both accepted.
 */
function fakeDriver(name: string) {
  return { name, connectionName: () => name } as any
}
function fakeResolver(name: string) {
  return { name, resolve: () => undefined } as any
}

test.group('IsolationDriverRegistry — name/dedup guard', () => {
  test('rejects an empty driver name', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    assert.throws(() => reg.register(fakeDriver('')), /non-empty string/)
  })

  test('rejects a duplicate name without override', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    reg.register(fakeDriver('schema-pg'))
    assert.throws(() => reg.register(fakeDriver('schema-pg')), /already registered/)
  })

  test('allows replacement with { override: true }', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    reg.register(fakeDriver('schema-pg'))
    assert.doesNotThrow(() => reg.register(fakeDriver('schema-pg'), { override: true }))
  })

  test("the provider's if(!has()) boot pattern stays green", ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    if (!reg.has('schema-pg')) reg.register(fakeDriver('schema-pg'), { activate: true })
    if (!reg.has('schema-pg')) reg.register(fakeDriver('schema-pg'), { activate: true })
    assert.equal(reg.active().name, 'schema-pg')
  })
})

test.group('TenantResolverRegistry — name/dedup guard', () => {
  test('rejects an empty resolver name', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    assert.throws(() => reg.register(fakeResolver('')), /non-empty string/)
  })

  test('rejects a duplicate name without override', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('header'))
    assert.throws(() => reg.register(fakeResolver('header')), /already registered/)
  })

  test('allows replacement with { override: true }', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('header'))
    assert.doesNotThrow(() => reg.register(fakeResolver('header'), { override: true }))
  })
})
