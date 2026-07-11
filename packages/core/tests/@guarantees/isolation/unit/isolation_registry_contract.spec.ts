import { test } from '@japa/runner'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'
import { ISOLATION_CONTRACT_VERSION } from '../../../../src/services/isolation/driver.js'
import TenantResolverRegistry from '../../../../src/services/resolvers/registry.js'
import { RESOLVER_CONTRACT_VERSION } from '../../../../src/services/resolvers/resolver.js'

/**
 * Contract-version enforcement for the isolation-driver and tenant-resolver
 * registries.
 *
 * Custom isolation drivers and tenant resolvers are third-party extensions, but
 * the registries used to accept any object regardless of the contract it was
 * built against. A driver compiled for a NEWER core contract would register and
 * then call methods the running core does not provide. This brings them in line
 * with the satellite ABI / extension-contract standard (see
 * sdk/contract_version.ts): a newer declared contract fails, an older one warns,
 * equal is ok, absent warns.
 *
 * Before the fix, the *_CONTRACT_VERSION constants were unexported (undefined),
 * and register() never compared versions, so a v999 driver registered silently.
 */
function driver(name: string, contractVersion?: number) {
  return {
    name,
    contractVersion,
    connectionName: () => name,
    connect: async () => ({}) as any,
    disconnect: async () => {},
    destroy: async () => {},
    reset: async () => {},
    migrate: async () => ({ executed: 0, noop: true }),
    enforce: () => {},
    tableLocation: () => ({ kind: 'connection', connectionName: name }),
  } as any
}
function resolver(name: string, contractVersion?: number) {
  return { name, contractVersion, resolve: () => undefined } as any
}

function captureWarn(fn: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  ;(console as any).warn = (m: string) => warnings.push(String(m))
  try {
    fn()
  } finally {
    ;(console as any).warn = original
  }
  return warnings
}

test.group('isolation/resolver contract versioning', () => {
  test('the contract-version constants are exported (isolation at v2 after tableLocation)', ({
    assert,
  }) => {
    assert.equal(ISOLATION_CONTRACT_VERSION, 2)
    assert.equal(RESOLVER_CONTRACT_VERSION, 1)
  })

  test('the registries expose their own contractVersion', ({ assert }) => {
    assert.equal(new IsolationDriverRegistry().contractVersion, ISOLATION_CONTRACT_VERSION)
    assert.equal(new TenantResolverRegistry().contractVersion, RESOLVER_CONTRACT_VERSION)
  })

  test('a driver built for a NEWER contract is refused', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    assert.throws(
      () => reg.register(driver('future', ISOLATION_CONTRACT_VERSION + 1)),
      /contract v/
    )
    assert.isFalse(reg.has('future'))
  })

  test('an equal-version driver registers', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    assert.doesNotThrow(() => reg.register(driver('ok', ISOLATION_CONTRACT_VERSION)))
    assert.isTrue(reg.has('ok'))
  })

  test('a driver with no contractVersion warns but still registers', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    const warnings = captureWarn(() => reg.register(driver('legacy')))
    assert.isTrue(reg.has('legacy'))
    assert.isTrue(warnings.some((w) => /contractVersion/.test(w)))
  })

  test('a resolver built for a NEWER contract is refused', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    assert.throws(
      () => reg.register(resolver('future', RESOLVER_CONTRACT_VERSION + 1)),
      /contract v/
    )
    assert.isFalse(reg.has('future'))
  })

  test('an equal-version resolver registers', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    assert.doesNotThrow(() => reg.register(resolver('ok', RESOLVER_CONTRACT_VERSION)))
    assert.isTrue(reg.has('ok'))
  })

  test('a resolver with no contractVersion warns but still registers', ({ assert }) => {
    const reg = new TenantResolverRegistry()
    const warnings = captureWarn(() => reg.register(resolver('legacy')))
    assert.isTrue(reg.has('legacy'))
    assert.isTrue(warnings.some((w) => /contractVersion/.test(w)))
  })
})
