import { test } from '@japa/runner'
import { assertResolverChain, wireResolverChain } from '../../../../src/providers/resolver_chain.js'
import TenantResolverRegistry from '../../../../src/services/resolvers/registry.js'
import {
  RESOLVER_CONTRACT_VERSION,
  ResolverHit,
  type TenantResolver,
} from '../../../../src/services/resolvers/resolver.js'
import { testConfig } from '../../../helpers/config.js'

/**
 * WS-7 / resolver-chain-string-only.
 *
 * `resolverChain` only accepted built-in string names, so a host could not chain
 * a custom resolver without reaching into the registry. It now accepts inline
 * `TenantResolver` instances (and a `config.resolvers` bag), and `validateConfig`
 * (assertResolverChain) rejects an unknown string name with a clear config-level
 * error instead of a registry-internal one.
 *
 * RED (pre-fix): the resolver_chain helper module did not exist; the chain was
 * string-only and an unknown name surfaced as a setChain registry error.
 */
const cfg = (over: Record<string, unknown>) => ({ ...testConfig, ...over }) as any
const custom: TenantResolver = {
  name: 'custom',
  contractVersion: RESOLVER_CONTRACT_VERSION,
  resolve: () => ResolverHit.id('11111111-1111-4111-8111-111111111111'),
  resolveSync: () => ResolverHit.id('11111111-1111-4111-8111-111111111111'),
}

test.group('assertResolverChain — config-level validation', () => {
  test('accepts a chain of built-in names', ({ assert }) => {
    assert.doesNotThrow(() => assertResolverChain(cfg({ resolverChain: ['header', 'subdomain'] })))
  })

  test('accepts an inline resolver instance in the chain', ({ assert }) => {
    assert.doesNotThrow(() => assertResolverChain(cfg({ resolverChain: [custom, 'header'] })))
  })

  test('accepts a string naming an instance from config.resolvers', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertResolverChain(cfg({ resolvers: [custom], resolverChain: ['custom'] }))
    )
  })

  test('throws a clear config-level error for an unknown name', ({ assert }) => {
    assert.throws(
      () => assertResolverChain(cfg({ resolverChain: ['nope'] })),
      /resolverChain references unknown resolver "nope"/
    )
  })

  test('an absent chain is a no-op', ({ assert }) => {
    assert.doesNotThrow(() => assertResolverChain(cfg({ resolverChain: undefined })))
  })
})

test.group('wireResolverChain — inline instances route', () => {
  test('an inline instance in the chain is registered and resolves', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    wireResolverChain(reg, cfg({ resolverChain: [custom] }))

    assert.isTrue(reg.has('custom'))
    assert.deepEqual(reg.resolveSync({} as any), {
      type: 'id',
      tenantId: '11111111-1111-4111-8111-111111111111',
    })
  })

  test('falls back to the single resolverStrategy when no chain is set', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    wireResolverChain(reg, cfg({ resolverStrategy: 'header', resolverChain: undefined }))
    assert.deepEqual([...reg.chain()], ['header'])
  })
})
