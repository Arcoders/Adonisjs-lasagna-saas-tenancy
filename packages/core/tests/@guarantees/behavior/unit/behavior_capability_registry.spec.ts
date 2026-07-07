import { test } from '@japa/runner'
import CapabilityRegistry, {
  CAPABILITY_CONTRACT_VERSION,
  type CapabilityProvision,
} from '../../../../src/services/capability_registry.js'
import { capabilityKey } from '../../../../src/sdk/brands.js'

function provision(name: string, api: unknown, contractVersion?: number): CapabilityProvision {
  return { kind: 'capability', name: capabilityKey(name), api, contractVersion }
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
