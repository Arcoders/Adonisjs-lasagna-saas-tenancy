import { test } from '@japa/runner'
import CapabilityRegistry, {
  CAPABILITY_CONTRACT_VERSION,
  type CapabilityProvision,
} from '../../../../src/services/capability_registry.js'
import { capabilityKey, pluginName } from '../../../../src/sdk/brands.js'
import { pluginScope } from '../../../../src/services/plugin_execution_scope.js'
import {
  snapshotIsthmusCounters,
  __resetIsthmusCounters,
  __setIsthmusDispatcherForTests,
} from '../../../../src/isthmus/audit.js'

const trustCounter = () =>
  snapshotIsthmusCounters().rejected.find((r) => r.id === 'guard.plugin_capability_trust')?.value ??
  0

function provision(name: string, api: unknown, contractVersion?: number): CapabilityProvision {
  return {
    kind: 'capability',
    name: capabilityKey(name),
    api,
    ...(contractVersion !== undefined ? { contractVersion } : {}),
  }
}

function sensitive(name: string, api: unknown): CapabilityProvision {
  return { kind: 'capability', name: capabilityKey(name), api, sensitive: true }
}

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.TRUSTED_SATELLITES
  if (value === undefined) delete process.env.TRUSTED_SATELLITES
  else process.env.TRUSTED_SATELLITES = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TRUSTED_SATELLITES
    else process.env.TRUSTED_SATELLITES = prev
  }
}

test.group('CapabilityRegistry', () => {
  test('exposes the contract version', ({ assert }) => {
    assert.equal(new CapabilityRegistry().contractVersion, CAPABILITY_CONTRACT_VERSION)
  })

  test('register / consume / has / list', ({ assert }) => {
    const reg = new CapabilityRegistry()
    const emailApi = { send: () => 'sent' }
    reg.register(provision('email', emailApi))
    reg.register(provision('search', { index: () => {} }))

    assert.strictEqual(reg.consume(capabilityKey('email')), emailApi)
    assert.isTrue(reg.has(capabilityKey('email')))
    assert.deepEqual([...reg.list()].sort(), ['email', 'search'])
  })

  test('consume returns undefined for an absent capability (degradable)', ({ assert }) => {
    const reg = new CapabilityRegistry()
    assert.isUndefined(reg.consume(capabilityKey('missing')))
    assert.isFalse(reg.has(capabilityKey('missing')))
  })

  test('a duplicate key throws a typed CapabilityCollisionException (500) — single-provider', ({
    assert,
  }) => {
    const reg = new CapabilityRegistry()
    reg.register(provision('email', { a: 1 }))
    try {
      reg.register(provision('email', { b: 2 }))
      assert.fail('expected a throw')
    } catch (err: any) {
      assert.equal(err.code, 'E_CAPABILITY_COLLISION')
      assert.equal(err.status, 500)
    }
  })

  test('a capability built for a NEWER contract is rejected', ({ assert }) => {
    const reg = new CapabilityRegistry()
    assert.throws(
      () => reg.register(provision('email', {}, CAPABILITY_CONTRACT_VERSION + 1)),
      /requires extension contract/
    )
  })
})

test.group('CapabilityRegistry — sensitive capability trust gate (S5)', () => {
  test('an ordinary (non-sensitive) capability ignores the allowlist', ({ assert }) => {
    withEnv(undefined, () => {
      const reg = new CapabilityRegistry()
      // No providerName, nothing trusted — a plain provision still registers.
      assert.doesNotThrow(() => reg.register(provision('email', { send() {} })))
      assert.isTrue(reg.has(capabilityKey('email')))
    })
  })

  test('a TRUSTED provider may provide a sensitive capability; core may consume it', ({
    assert,
  }) => {
    withEnv('reporting', () => {
      const reg = new CapabilityRegistry()
      const api = { readKeys() {} }
      reg.register(sensitive('secret_keys', api), pluginName('reporting'))
      // Consumed from core (no plugin scope) → returns the api.
      assert.strictEqual(reg.consume(capabilityKey('secret_keys')), api)
    })
  })

  test('an UNTRUSTED provider providing a sensitive capability throws (403)', ({ assert }) => {
    withEnv('reporting', () => {
      const reg = new CapabilityRegistry()
      try {
        reg.register(sensitive('secret_keys', {}), pluginName('sketchy'))
        assert.fail('expected a CapabilityTrustException')
      } catch (err: any) {
        assert.equal(err.code, 'E_CAPABILITY_TRUST')
        assert.equal(err.status, 403)
        assert.match(err.message, /refusing to provide sensitive capability/)
      }
      // The refused capability was never stored.
      assert.isFalse(reg.has(capabilityKey('secret_keys')))
    })
  })

  test('a sensitive provision with no attributable provider fails closed', ({ assert }) => {
    withEnv('reporting', () => {
      const reg = new CapabilityRegistry()
      assert.throws(() => reg.register(sensitive('secret_keys', {})), /refusing to provide/)
    })
  })

  test('untrusted plugin code cannot consume a sensitive capability', ({ assert }) => {
    withEnv('reporting', () => {
      const reg = new CapabilityRegistry()
      const api = { readKeys() {} }
      reg.register(sensitive('secret_keys', api), pluginName('reporting'))

      __setIsthmusDispatcherForTests(async () => {})
      __resetIsthmusCounters()
      try {
        // A trusted plugin scope consumes fine and does NOT trip the guard.
        assert.strictEqual(
          pluginScope.run({ plugin: pluginName('reporting'), trusted: true }, () =>
            reg.consume(capabilityKey('secret_keys'))
          ),
          api
        )
        assert.equal(trustCounter(), 0, 'a trusted consume must not trip the guard')

        // An untrusted plugin scope is denied (fail-closed, not degraded-to-undefined)
        // AND the consume-side guard fires — the audit signal, separate from the throw
        // (a mutation that drops only the emit while keeping the throw is caught here).
        let threw: any
        pluginScope.run({ plugin: pluginName('sketchy'), trusted: false }, () => {
          try {
            reg.consume(capabilityKey('secret_keys'))
          } catch (err) {
            threw = err
          }
        })
        assert.equal(threw?.code, 'E_CAPABILITY_TRUST')
        assert.match(threw.message, /refusing to let untrusted plugin "sketchy" consume/)
        assert.equal(trustCounter(), 1, 'the consume-side guard must be emitted exactly once')
      } finally {
        __resetIsthmusCounters()
        __setIsthmusDispatcherForTests(undefined)
      }
    })
  })
})
