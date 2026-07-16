import { test } from '@japa/runner'
import TenantResolverRegistry from '../../../../src/services/resolvers/registry.js'
import {
  RESOLVER_CONTRACT_VERSION,
  ResolverHit,
  type TenantResolver,
} from '../../../../src/services/resolvers/resolver.js'

function fakeResolver(
  name: string,
  returns: ReturnType<typeof ResolverHit.id> | undefined
): TenantResolver {
  return {
    name,
    contractVersion: RESOLVER_CONTRACT_VERSION,
    // A synchronous resolver: resolve and resolveSync agree, so it is chain-eligible.
    resolve() {
      return returns
    },
    resolveSync() {
      return returns
    },
  }
}

test.group('TenantResolverRegistry — registration', () => {
  test('register adds resolvers and list/has reflect them', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('a', undefined))
    reg.register(fakeResolver('b', undefined))
    assert.deepEqual([...reg.list()].sort(), ['a', 'b'])
    assert.isTrue(reg.has('a'))
    assert.isFalse(reg.has('missing'))
  })

  test('unregister removes the resolver and reports the previous presence', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('a', undefined))
    assert.isTrue(reg.unregister('a'))
    assert.isFalse(reg.unregister('a'))
  })

  test('clear empties everything', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('a', undefined))
    reg.setChain(['a'])
    reg.clear()
    assert.deepEqual(reg.list(), [])
    assert.deepEqual(reg.chain(), [])
  })
})

test.group('TenantResolverRegistry — chain', () => {
  test('setChain rejects unknown resolver names at boot time', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('a', undefined))
    assert.throws(() => reg.setChain(['a', 'missing']), /unknown resolver "missing"/)
  })

  test('resolve returns the first non-undefined hit', async ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('a', undefined))
    reg.register(fakeResolver('b', ResolverHit.id('match')))
    reg.register(fakeResolver('c', ResolverHit.id('would-also-match')))
    reg.setChain(['a', 'b', 'c'])

    const result = await reg.resolve({} as any)
    assert.deepEqual(result, { type: 'id', tenantId: 'match' })
  })

  test('resolve returns undefined when nothing in the chain matches', async ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('a', undefined))
    reg.register(fakeResolver('b', undefined))
    reg.setChain(['a', 'b'])

    assert.isUndefined(await reg.resolve({} as any))
  })

  test('resolve respects chain order — later registration does not jump ahead', async ({
    assert,
  }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('a', ResolverHit.id('A')))
    reg.register(fakeResolver('b', ResolverHit.id('B')))
    reg.setChain(['b', 'a'])
    const result = await reg.resolve({} as any)
    assert.deepEqual(result, { type: 'id', tenantId: 'B' })
  })
})

test.group('TenantResolverRegistry — resolveSync', () => {
  const asyncOnlyResolver = (name: string): TenantResolver => ({
    name,
    contractVersion: RESOLVER_CONTRACT_VERSION,
    // No resolveSync: an async-only resolver, which cannot serve the sync path.
    async resolve() {
      return ResolverHit.id('x')
    },
  })

  test('returns the first synchronous hit', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('a', undefined))
    reg.register(fakeResolver('b', ResolverHit.id('match')))
    reg.register(fakeResolver('c', ResolverHit.id('would-also-match')))
    reg.setChain(['a', 'b', 'c'])
    assert.deepEqual(reg.resolveSync({} as any), { type: 'id', tenantId: 'match' })
  })

  test('setChain fails closed on an async-only resolver (no split-brain)', ({ assert }) => {
    // TRES-06: an async-only resolver cannot be placed in the routing chain. The
    // old behavior silently skipped it on the sync path; now setChain refuses it
    // so request.tenant() and the sync attribution path can never diverge.
    const reg = new TenantResolverRegistry()
    reg.register(asyncOnlyResolver('async'))
    reg.register(fakeResolver('sync', ResolverHit.id('sync-hit')))
    assert.throws(() => reg.setChain(['async', 'sync']), /async-only/)
  })

  test('returns undefined when nothing in the chain matches synchronously', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    reg.register(fakeResolver('a', undefined))
    reg.setChain(['a'])
    assert.isUndefined(reg.resolveSync({} as any))
  })
})
